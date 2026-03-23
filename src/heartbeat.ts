import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, GROUPS_DIR, TIMEZONE } from './config.js';
import { runContainerAgent } from './container-runner.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const HEARTBEAT_FILE = 'heartbeat.json';
const RECHECK_MS = 5 * 60_000; // Re-check disabled/missing heartbeat every 5 min

interface HeartbeatConfig {
  enabled: boolean;
  /** Local hour (0–23) when daytime window opens */
  dayStart: number;
  /** Local hour (0–23) when daytime window closes */
  dayEnd: number;
  dayIntervalMins: number;
  nightIntervalMins: number;
  /** Agenda items — each is a short instruction for the agent */
  agenda: string[];
}

export interface HeartbeatDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

function readConfig(groupFolder: string): HeartbeatConfig | null {
  try {
    const raw = fs.readFileSync(
      path.join(GROUPS_DIR, groupFolder, HEARTBEAT_FILE),
      'utf8',
    );
    return JSON.parse(raw) as HeartbeatConfig;
  } catch {
    return null;
  }
}

function nextIntervalMs(config: HeartbeatConfig): number {
  const now = new Date();
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: TIMEZONE,
    }).format(now),
    10,
  );
  const isDay = hour >= config.dayStart && hour < config.dayEnd;
  return (isDay ? config.dayIntervalMins : config.nightIntervalMins) * 60_000;
}

async function runHeartbeat(
  chatJid: string,
  group: RegisteredGroup,
  config: HeartbeatConfig,
  deps: HeartbeatDependencies,
): Promise<void> {
  const agendaList = config.agenda
    .map((item, i) => `${i + 1}. ${item}`)
    .join('\n');

  const prompt = [
    '[Heartbeat check-in]',
    '',
    `Your agenda is in /workspace/group/${HEARTBEAT_FILE}. Current items:`,
    agendaList,
    '',
    'Work through each item and send a concise summary of what you did or found.',
    'If nothing needs attention, say so briefly.',
    '',
    `You can update /workspace/group/${HEARTBEAT_FILE} to change your agenda,`,
    `adjust dayIntervalMins (currently ${config.dayIntervalMins}) or nightIntervalMins (currently ${config.nightIntervalMins}),`,
    `or change dayStart (${config.dayStart}:00) / dayEnd (${config.dayEnd}:00).`,
    'Set enabled to false to pause heartbeats.',
  ].join('\n');

  logger.info(
    { group: group.name, agendaItems: config.agenda.length },
    'Running heartbeat',
  );

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId: deps.getSessions()[group.folder],
        groupFolder: group.folder,
        chatJid,
        isMain: group.isMain === true,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        deps.onProcess(chatJid, proc, containerName, group.folder),
      async (streamed) => {
        if (streamed.result) {
          await deps.sendMessage(chatJid, streamed.result);
          setTimeout(() => deps.queue.closeStdin(chatJid), 10_000);
        }
        if (streamed.status === 'success') {
          deps.queue.notifyIdle(chatJid);
        }
      },
    );

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Heartbeat run failed',
      );
    }
  } catch (err) {
    logger.error({ group: group.name, err }, 'Heartbeat error');
  }
}

function startGroupHeartbeat(
  chatJid: string,
  groupFolder: string,
  deps: HeartbeatDependencies,
): void {
  const tick = () => {
    // Re-read config on every tick so agent-written changes take effect
    const config = readConfig(groupFolder);

    if (config?.enabled) {
      const group = deps.registeredGroups()[chatJid];
      if (group) {
        deps.queue.enqueueTask(chatJid, 'heartbeat', () =>
          runHeartbeat(chatJid, group, config, deps),
        );
      } else {
        logger.warn({ groupFolder }, 'Heartbeat: group no longer registered');
      }
    }

    const nextMs = config?.enabled ? nextIntervalMs(config) : RECHECK_MS;
    logger.debug({ groupFolder, nextMs }, 'Next heartbeat scheduled');
    setTimeout(tick, nextMs);
  };

  // Schedule first tick based on current config (or recheck delay if missing)
  const config = readConfig(groupFolder);
  const firstMs = config?.enabled ? nextIntervalMs(config) : RECHECK_MS;
  logger.info({ groupFolder, firstMs }, 'Heartbeat initialised');
  setTimeout(tick, firstMs);
}

/**
 * Start a heartbeat timer for every currently-registered group.
 * Each group's timer re-reads its heartbeat.json on every tick, so
 * the agent can update the schedule and agenda without a restart.
 * Groups without a heartbeat.json re-check every 5 min, so the file
 * can be added at any time and will be picked up automatically.
 */
export function startHeartbeats(deps: HeartbeatDependencies): void {
  const groups = deps.registeredGroups();
  for (const [chatJid, group] of Object.entries(groups)) {
    startGroupHeartbeat(chatJid, group.folder, deps);
  }
}
