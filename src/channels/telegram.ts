import https from 'https';
import path from 'path';

import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { processImage } from '../image.js';
import { transcribeAudioBuffer } from '../transcription.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Build a Telegram JID from a chat ID and optional forum topic (thread) ID.
 * Non-topic messages: `tg:{chatId}`
 * Topic messages:     `tg:{chatId}:{threadId}`
 */
function buildJid(chatId: number | string, threadId?: number): string {
  return threadId ? `tg:${chatId}:${threadId}` : `tg:${chatId}`;
}

/**
 * Parse a Telegram JID back to its components.
 * Handles both `tg:{chatId}` and `tg:{chatId}:{threadId}`.
 */
function parseJid(jid: string): { chatId: string; threadId?: number } {
  const rest = jid.replace(/^tg:/, '');
  const colonIdx = rest.lastIndexOf(':');
  if (colonIdx === -1) return { chatId: rest };
  const chatId = rest.slice(0, colonIdx);
  const threadId = Number(rest.slice(colonIdx + 1));
  return { chatId, threadId: isNaN(threadId) ? undefined : threadId };
}

/**
 * Extract reply context from a replied-to message, returning a prefix string
 * like `[Replying to @Name: "text"] ` so the agent sees what was being replied to.
 */
function getReplyContext(replyTo: any): string {
  if (!replyTo) return '';
  const name =
    replyTo.from?.first_name ||
    replyTo.from?.username ||
    replyTo.from?.id?.toString() ||
    'Unknown';
  const text =
    replyTo.text ||
    replyTo.caption ||
    (replyTo.photo ? '[Photo]' : null) ||
    (replyTo.voice ? '[Voice]' : null) ||
    (replyTo.video ? '[Video]' : null) ||
    (replyTo.document ? '[Document]' : null) ||
    '[message]';
  return `[Replying to @${name}: "${text}"] `;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration).
    // When used inside a forum topic, reports the topic-scoped JID.
    this.bot.command('chatid', (ctx) => {
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';
      const threadId = ctx.message?.message_thread_id;
      const chatJid = buildJid(ctx.chat.id, threadId);

      ctx.reply(
        `Chat ID: \`${chatJid}\`\nName: ${chatName}\nType: ${chatType}${threadId ? `\nTopic ID: ${threadId}` : ''}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Forward NanoClaw slash commands to the message handler
    for (const cmd of ['remote_control', 'remote_control_end', 'compact']) {
      this.bot.command(cmd, (ctx) => {
        if (!ctx.message) return;
        const threadId = ctx.message.message_thread_id;
        const chatJid = buildJid(ctx.chat.id, threadId);
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) return;
        const timestamp = new Date(ctx.message.date * 1000).toISOString();
        const senderName =
          ctx.from?.first_name ||
          ctx.from?.username ||
          ctx.from?.id.toString() ||
          'Unknown';
        // Translate Telegram underscore command back to hyphen form
        const content = `/${cmd.replace(/_/g, '-')}`;
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      });
    }

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const threadId = ctx.message.message_thread_id;
      const chatJid = buildJid(ctx.chat.id, threadId);
      let content =
        getReplyContext(ctx.message.reply_to_message) + ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages with placeholders so the agent knows something was sent
    const storeNonText = (ctx: any, placeholder: string) => {
      const threadId = ctx.message.message_thread_id;
      const chatJid = buildJid(ctx.chat.id, threadId);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      const threadId = ctx.message.message_thread_id;
      const chatJid = buildJid(ctx.chat.id, threadId);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ?? '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const replyPrefix = getReplyContext(ctx.message.reply_to_message);
      let content = replyPrefix + (caption ? `[Photo] ${caption}` : '[Photo]');

      try {
        // Pick the largest available photo size
        const photos = ctx.message.photo;
        const largest = photos[photos.length - 1];
        const file = await this.bot!.api.getFile(largest.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

        const buffer = await new Promise<Buffer>((resolve, reject) => {
          https.get(fileUrl, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
          });
        });

        const groupDir = path.join(GROUPS_DIR, group.folder);
        const result = await processImage(buffer, groupDir, caption);
        if (result) content = replyPrefix + result.content;
      } catch (err) {
        logger.warn({ err, chatJid }, 'Telegram image download failed');
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    this.bot.on('message:video', (ctx) => storeNonText(ctx, '[Video]'));

    this.bot.on('message:voice', async (ctx) => {
      const threadId = ctx.message.message_thread_id;
      const chatJid = buildJid(ctx.chat.id, threadId);
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      let content = '[Voice Message - transcription unavailable]';

      try {
        const file = await this.bot!.api.getFile(ctx.message.voice.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

        const buffer = await new Promise<Buffer>((resolve, reject) => {
          https.get(fileUrl, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
          });
        });

        const transcript = await transcribeAudioBuffer(buffer);
        if (transcript) {
          content = `[Voice: ${transcript}]`;
          logger.info(
            { chatJid, length: transcript.length },
            'Transcribed Telegram voice message',
          );
        }
      } catch (err) {
        logger.error({ err, chatJid }, 'Telegram voice transcription failed');
        content = '[Voice Message - transcription failed]';
      }

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    });

    this.bot.on('message:audio', (ctx) => storeNonText(ctx, '[Audio]'));
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeNonText(ctx, `[Document: ${name}]`);
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const { chatId, threadId } = parseJid(jid);
      const options = threadId ? { message_thread_id: threadId } : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, chatId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            chatId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const { chatId, threadId } = parseJid(jid);
      const options = threadId ? { message_thread_id: threadId } : {};
      await this.bot.api.sendChatAction(chatId, 'typing', options);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
