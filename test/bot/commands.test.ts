import { describe, it, expect, beforeEach, vi } from 'vitest';

// The naming run spawns the CLI; stub it so /autopause tests stay hermetic.
const mockRequestSessionName = vi.fn();
vi.mock('../../src/claude/session-namer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/claude/session-namer.js')>();
  return { ...actual, requestSessionName: (...args: any[]) => mockRequestSessionName(...args) };
});

import {
  CommandHandler,
  isSessionGuid,
  renderSessionReport,
  samePath,
  type SessionReport,
} from '../../src/bot/commands.js';

// Mock ClaudeManager
const mockClaudeManager = {
  clearSession: vi.fn(),
  archiveSessionCost: vi.fn(),
  hasActiveProcess: vi.fn(),
  killActiveProcess: vi.fn(),
  killAllProcesses: vi.fn().mockReturnValue(0),
  setModel: vi.fn(),
  getModel: vi.fn().mockReturnValue('sonnet'),
  // Session pause/resume surface used by /resume
  getSessionId: vi.fn(),
  getResumableSessions: vi.fn().mockReturnValue([]),
  pauseSession: vi.fn(),
  resumeSession: vi.fn().mockReturnValue(true),
  setSessionFromAdopt: vi.fn(),
  // /autopause surface
  autoPauseSession: vi.fn(),
  getPausedSessions: vi.fn().mockReturnValue([]),
  renamePausedSession: vi.fn().mockReturnValue(true),
  // /session surface
  getSessionInfo: vi.fn(),
  getSessionWorkingDir: vi.fn(),
  getLiveTaskCount: vi.fn().mockReturnValue(0),
  getModelForRun: vi.fn().mockReturnValue('claude-opus-5'),
  isPlanMode: vi.fn().mockReturnValue(false),
  hasActiveWatchers: vi.fn().mockReturnValue(false),
  getPromptCount: vi.fn().mockReturnValue(0),
};

const mockSettings = {
  setHomeCategory: vi.fn(),
};

describe('CommandHandler', () => {
  let commandHandler: CommandHandler;
  const allowedUserId = 'user-123';

  beforeEach(() => {
    commandHandler = new CommandHandler(mockClaudeManager as any, allowedUserId, mockSettings as any);
    vi.clearAllMocks();
  });

  describe('getCommands', () => {
    it('should return array of slash commands', () => {
      const commands = commandHandler.getCommands();
      expect(commands).toHaveLength(26);
      expect(commands[0]!.name).toBe('clear');
      expect(commands[1]!.name).toBe('kill');
      expect(commands[2]!.name).toBe('stop');
      expect(commands[3]!.name).toBe('model');
      expect(commands[4]!.name).toBe('killall');
      expect(commands[5]!.name).toBe('add');
      expect(commands[6]!.name).toBe('plan');
      expect(commands[7]!.name).toBe('update');
      expect(commands[8]!.name).toBe('restart');
      expect(commands[9]!.name).toBe('shutdown');
      expect(commands[10]!.name).toBe('init');
      expect(commands[11]!.name).toBe('shortcut');
      expect(commands[12]!.name).toBe('sync');
      expect(commands[13]!.name).toBe('end');
      expect(commands[14]!.name).toBe('adopt');
      expect(commands[15]!.name).toBe('status');
      expect(commands[16]!.name).toBe('todo');
      expect(commands[17]!.name).toBe('session');
      expect(commands[18]!.name).toBe('pause');
      expect(commands[19]!.name).toBe('autopause');
      expect(commands[20]!.name).toBe('resume');
      expect(commands[21]!.name).toBe('online');
      expect(commands[22]!.name).toBe('costreview');
      expect(commands[23]!.name).toBe('interrupt');
      expect(commands[24]!.name).toBe('btw');
      expect(commands[25]!.name).toBe('file');
    });
  });

  describe('handleInteraction', () => {
    it('should ignore non-chat input commands', async () => {
      const mockInteraction = {
        isChatInputCommand: () => false,
      };

      await commandHandler.handleInteraction(mockInteraction);
      // Should not throw or call any methods
      expect(mockClaudeManager.clearSession).not.toHaveBeenCalled();
    });

    it('should deny unauthorized users', async () => {
      const mockInteraction = {
        isChatInputCommand: () => true,
        user: { id: 'unauthorized-user' },
        reply: vi.fn(),
      };

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith({
        content: 'You are not authorized to use this bot.',
        ephemeral: true,
      });
      expect(mockClaudeManager.clearSession).not.toHaveBeenCalled();
    });

    it('should handle clear command for authorized user', async () => {
      const channelId = 'channel-123';
      const mockInteraction = {
        isChatInputCommand: () => true,
        user: { id: allowedUserId },
        channelId,
        commandName: 'clear',
        reply: vi.fn(),
      };

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockClaudeManager.clearSession).toHaveBeenCalledWith(channelId);
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        'Session cleared! Next message will start a new Claude Code session.'
      );
    });

    it('should ignore unknown commands', async () => {
      const mockInteraction = {
        isChatInputCommand: () => true,
        user: { id: allowedUserId },
        channelId: 'channel-123',
        commandName: 'unknown',
        reply: vi.fn(),
      };

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockClaudeManager.clearSession).not.toHaveBeenCalled();
      expect(mockInteraction.reply).not.toHaveBeenCalled();
    });

    it('should handle init command for authorized user', async () => {
      const mockInteraction = {
        isChatInputCommand: () => true,
        user: { id: allowedUserId },
        channelId: 'channel-123',
        commandName: 'init',
        channel: { parentId: 'category-456', parent: { name: 'My Projects' } },
        guild: { id: 'guild-789' },
        reply: vi.fn(),
      };

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockSettings.setHomeCategory).toHaveBeenCalledWith('guild-789', 'category-456');
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.stringContaining('My Projects')
      );
    });

    it('should reject init when channel has no category', async () => {
      const mockInteraction = {
        isChatInputCommand: () => true,
        user: { id: allowedUserId },
        channelId: 'channel-123',
        commandName: 'init',
        channel: { parentId: null, parent: null },
        guild: { id: 'guild-789' },
        reply: vi.fn(),
      };

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockSettings.setHomeCategory).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ ephemeral: true })
      );
    });

    it('should reject init when not in a guild', async () => {
      const mockInteraction = {
        isChatInputCommand: () => true,
        user: { id: allowedUserId },
        channelId: 'channel-123',
        commandName: 'init',
        channel: { parentId: 'category-456', parent: { name: 'My Projects' } },
        guild: null,
        reply: vi.fn(),
      };

      await commandHandler.handleInteraction(mockInteraction);

      expect(mockSettings.setHomeCategory).not.toHaveBeenCalled();
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ ephemeral: true })
      );
    });
  });

  describe('isSessionGuid', () => {
    it('accepts a v4-style session id', () => {
      expect(isSessionGuid('6387edd3-cb1a-40c4-8dd4-2b7948df354f')).toBe(true);
      expect(isSessionGuid('  6387EDD3-CB1A-40C4-8DD4-2B7948DF354F  ')).toBe(true); // trimmed, case-insensitive
    });

    it('rejects plain names and malformed ids', () => {
      expect(isSessionGuid('my-session')).toBe(false);
      expect(isSessionGuid('6387edd3')).toBe(false); // truncated
      expect(isSessionGuid('6387edd3-cb1a-40c4-8dd4-2b7948df354')).toBe(false); // last group too short
      expect(isSessionGuid('')).toBe(false);
    });
  });

  describe('samePath', () => {
    it('matches git porcelain output against a path.join path', () => {
      // git prints forward slashes on every platform; path.join on Windows does not.
      expect(samePath('E:/repos/proj', 'E:\\repos\\proj')).toBe(true);
    });

    it('ignores a trailing separator and repeated separators', () => {
      expect(samePath('/repos/proj/', '/repos/proj')).toBe(true);
      expect(samePath('/repos//proj', '/repos/proj')).toBe(true);
    });

    it('does not match a different worktree under the same repo', () => {
      expect(samePath('E:/repos/proj/.claude/worktrees/feature', 'E:\\repos\\proj')).toBe(false);
    });
  });

  describe('autopause command', () => {
    const GUID = '6387edd3-cb1a-40c4-8dd4-2b7948df354f';
    const paused = { sessionId: GUID, model: 'claude-opus-5', workingDir: '/repos/my-chan' };

    function autopauseInteraction() {
      return {
        isChatInputCommand: () => true,
        user: { id: allowedUserId },
        channelId: 'channel-123',
        commandName: 'autopause',
        channel: { name: 'my-chan' },
        options: { getString: () => null },
        reply: vi.fn(),
        followUp: vi.fn(),
      };
    }

    /** Let the un-awaited naming continuation run to completion. */
    const settle = () => new Promise((r) => setImmediate(r));

    it('pauses under the session id and replies before the name exists', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.autoPauseSession.mockReturnValue(paused);
      mockRequestSessionName.mockReturnValue(new Promise(() => {})); // never resolves

      const interaction = autopauseInteraction();
      await commandHandler.handleInteraction(interaction);

      expect(mockClaudeManager.autoPauseSession).toHaveBeenCalledWith('channel-123', 'my-chan');
      expect(interaction.reply).toHaveBeenCalledWith(expect.stringContaining(GUID));
      expect(interaction.followUp).not.toHaveBeenCalled();
    });

    it('renames the paused row once Claude answers', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.autoPauseSession.mockReturnValue(paused);
      mockClaudeManager.getPausedSessions.mockReturnValue([]);
      mockClaudeManager.renamePausedSession.mockReturnValue(true);
      mockRequestSessionName.mockResolvedValue('autopause-command');

      const interaction = autopauseInteraction();
      await commandHandler.handleInteraction(interaction);
      await settle();

      expect(mockClaudeManager.renamePausedSession).toHaveBeenCalledWith(
        'channel-123',
        GUID,
        'autopause-command'
      );
      expect(interaction.followUp).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('autopause-command') })
      );
    });

    it('suffixes a name that collides with an existing paused session', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.autoPauseSession.mockReturnValue(paused);
      mockClaudeManager.getPausedSessions.mockReturnValue([{ name: 'autopause-command' }]);
      mockClaudeManager.renamePausedSession.mockReturnValue(true);
      mockRequestSessionName.mockResolvedValue('autopause-command');

      await commandHandler.handleInteraction(autopauseInteraction());
      await settle();

      expect(mockClaudeManager.renamePausedSession).toHaveBeenCalledWith(
        'channel-123',
        GUID,
        'autopause-command-2'
      );
    });

    it('leaves the session under its id when no name comes back', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.autoPauseSession.mockReturnValue(paused);
      mockRequestSessionName.mockResolvedValue(undefined);

      const interaction = autopauseInteraction();
      await commandHandler.handleInteraction(interaction);
      await settle();

      expect(mockClaudeManager.renamePausedSession).not.toHaveBeenCalled();
      expect(interaction.followUp).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining(GUID) })
      );
    });

    it('resolves the parent channel in a thread, not the thread name', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.autoPauseSession.mockReturnValue(paused);
      mockRequestSessionName.mockReturnValue(new Promise(() => {}));

      const interaction = autopauseInteraction();
      interaction.channel = { name: 'fix-login-bug', isThread: () => true, parent: { name: 'my-chan' } } as any;
      await commandHandler.handleInteraction(interaction);

      expect(mockClaudeManager.autoPauseSession).toHaveBeenCalledWith('channel-123', 'my-chan');
    });

    it('still pauses but skips naming when the project folder is missing', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.autoPauseSession.mockReturnValue({ sessionId: GUID, model: 'claude-opus-5' });

      const interaction = autopauseInteraction();
      await commandHandler.handleInteraction(interaction);
      await settle();

      expect(mockRequestSessionName).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(expect.stringContaining(GUID));
      expect(interaction.followUp).not.toHaveBeenCalled();
    });

    it('refuses while a process is running', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(true);

      const interaction = autopauseInteraction();
      await commandHandler.handleInteraction(interaction);

      expect(mockClaudeManager.autoPauseSession).not.toHaveBeenCalled();
      expect(mockRequestSessionName).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ ephemeral: true })
      );
    });

    it('reports when there is no session to pause', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.autoPauseSession.mockReturnValue(undefined);

      const interaction = autopauseInteraction();
      await commandHandler.handleInteraction(interaction);

      expect(mockRequestSessionName).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('No active session') })
      );
    });
  });

  describe('session command', () => {
    function sessionInteraction() {
      return {
        isChatInputCommand: () => true,
        user: { id: allowedUserId },
        channelId: 'channel-123',
        commandName: 'session',
        channel: { name: 'my-chan' },
        options: { getString: () => null },
        reply: vi.fn(),
      };
    }

    it('reports no active session when the channel has none', async () => {
      mockClaudeManager.getSessionInfo.mockReturnValue(undefined);
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);

      const interaction = sessionInteraction();
      await commandHandler.handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({ content: 'No active session', ephemeral: true });
    });

    it('says a first turn is still starting rather than "no session"', async () => {
      mockClaudeManager.getSessionInfo.mockReturnValue(undefined);
      mockClaudeManager.hasActiveProcess.mockReturnValue(true);

      const interaction = sessionInteraction();
      await commandHandler.handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('first turn is running') }),
      );
    });

    it('reports the id, the resumed-from name and the spend', async () => {
      mockClaudeManager.getSessionInfo.mockReturnValue({
        channelId: 'channel-123',
        sessionId: 'sess-1',
        channelName: 'my-chan',
        lastUsed: Date.now(),
        totalCostUsd: 1.5,
        sessionModel: 'claude-opus-5',
        resumedFrom: 'refactor-queue',
        resumedAt: Date.now(),
      });
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.getResumableSessions.mockReturnValue([{ name: 'other-work' }]);
      // A cleared session's archived spend still counts toward "all sessions".
      mockClaudeManager.getPausedSessions.mockReturnValue([{ totalCostUsd: 0.5 }]);
      mockClaudeManager.getPromptCount.mockReturnValue(7);

      const interaction = sessionInteraction();
      await commandHandler.handleInteraction(interaction);

      const content = interaction.reply.mock.calls[0]![0].content as string;
      expect(content).toContain('sess-1');
      expect(content).toContain('Resumed from **refactor-queue**');
      expect(content).toContain('$1.5000 this session');
      expect(content).toContain('$2.0000 all sessions here');
      expect(content).toContain('7 prompts');
      expect(content).toContain('other-work');
    });
  });

  describe('renderSessionReport', () => {
    const base: SessionReport = {
      sessionId: 'sess-1',
      state: 'active',
      liveTasks: 0,
      model: 'claude-opus-5',
      modelPinned: true,
      channelDefaultModel: 'claude-opus-5',
      planMode: false,
      currentSessionCost: 0,
      allSessionsCost: 0,
      promptCount: 1,
      lastUsed: Date.now(),
      pausedNames: [],
    };

    it('omits the resumed-from line for a session that was never named', () => {
      expect(renderSessionReport(base)).not.toContain('Resumed from');
    });

    it('names what a waiting session is blocked on', () => {
      const text = renderSessionReport({ ...base, state: 'waiting', waitingKind: 'approval' });
      expect(text).toContain('Waiting (approval)');
    });

    it('counts live background tasks alongside the state', () => {
      expect(renderSessionReport({ ...base, state: 'watching', liveTasks: 2 }))
        .toContain('2 background tasks');
    });

    it('flags a session pinned to a model the channel no longer defaults to', () => {
      const text = renderSessionReport({ ...base, channelDefaultModel: 'claude-sonnet-5' });
      expect(text).toContain('new sessions here use **claude-sonnet-5**');
    });

    it('says nothing about the channel default when it matches', () => {
      expect(renderSessionReport(base)).not.toContain('new sessions here');
    });

    it('marks a session created before pinning as a legacy default', () => {
      expect(renderSessionReport({ ...base, modelPinned: false })).toContain('legacy default');
    });

    it('stays inside a Discord message', () => {
      const text = renderSessionReport({
        ...base,
        lastSummary: 'x'.repeat(4000),
        pausedNames: Array.from({ length: 40 }, (_, i) => `paused-${i}`),
      });
      expect(text.length).toBeLessThanOrEqual(2000);
      expect(text).toContain('+32 more');
    });
  });

  describe('resume command', () => {
    const GUID = '6387edd3-cb1a-40c4-8dd4-2b7948df354f';

    function resumeInteraction(input: string) {
      return {
        isChatInputCommand: () => true,
        user: { id: allowedUserId },
        channelId: 'channel-123',
        commandName: 'resume',
        channel: { name: 'my-chan' },
        options: { getString: (k: string) => (k === 'name' ? input : null) },
        reply: vi.fn(),
      };
    }

    it('resumes a raw GUID and does not pause when no session is active', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.getResumableSessions.mockReturnValue([]);
      mockClaudeManager.getSessionId.mockReturnValue(undefined);

      const interaction = resumeInteraction(GUID);
      await commandHandler.handleInteraction(interaction);

      expect(mockClaudeManager.setSessionFromAdopt).toHaveBeenCalledWith('channel-123', GUID, 'my-chan');
      expect(mockClaudeManager.pauseSession).not.toHaveBeenCalled();
      expect(mockClaudeManager.resumeSession).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(expect.stringContaining(GUID));
    });

    it('auto-pauses the current session under its id before resuming a GUID', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.getResumableSessions.mockReturnValue([]);
      mockClaudeManager.getSessionId.mockReturnValue('current-aaaa-bbbb-cccc-dddddddddddd');

      const interaction = resumeInteraction(GUID);
      await commandHandler.handleInteraction(interaction);

      expect(mockClaudeManager.pauseSession).toHaveBeenCalledWith('channel-123', 'current-aaaa-bbbb-cccc-dddddddddddd');
      expect(mockClaudeManager.setSessionFromAdopt).toHaveBeenCalledWith('channel-123', GUID, 'my-chan');
      expect(interaction.reply).toHaveBeenCalledWith(expect.stringContaining('current-aaaa-bbbb-cccc-dddddddddddd'));
    });

    it('resumes a paused session by name (paused-name wins over GUID shape)', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.getResumableSessions.mockReturnValue([{ name: 'feature-x', pausedAt: 0, totalCostUsd: 0, isResumable: true }]);
      mockClaudeManager.getSessionId.mockReturnValue('current-aaaa-bbbb-cccc-dddddddddddd');

      const interaction = resumeInteraction('feature-x');
      await commandHandler.handleInteraction(interaction);

      expect(mockClaudeManager.pauseSession).toHaveBeenCalledWith('channel-123', 'current-aaaa-bbbb-cccc-dddddddddddd');
      expect(mockClaudeManager.resumeSession).toHaveBeenCalledWith('channel-123', 'feature-x', 'my-chan');
      expect(mockClaudeManager.setSessionFromAdopt).not.toHaveBeenCalled();
    });

    it('rejects input that is neither a paused name nor a GUID', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.getResumableSessions.mockReturnValue([]);
      mockClaudeManager.getSessionId.mockReturnValue('current-aaaa-bbbb-cccc-dddddddddddd');

      const interaction = resumeInteraction('not-a-real-thing');
      await commandHandler.handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
      expect(mockClaudeManager.pauseSession).not.toHaveBeenCalled();
      expect(mockClaudeManager.setSessionFromAdopt).not.toHaveBeenCalled();
      expect(mockClaudeManager.resumeSession).not.toHaveBeenCalled();
    });

    it('refuses to switch while a process is running', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(true);

      const interaction = resumeInteraction(GUID);
      await commandHandler.handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
      expect(mockClaudeManager.pauseSession).not.toHaveBeenCalled();
      expect(mockClaudeManager.setSessionFromAdopt).not.toHaveBeenCalled();
    });

    it('is a no-op when the GUID is already the active session', async () => {
      mockClaudeManager.hasActiveProcess.mockReturnValue(false);
      mockClaudeManager.getResumableSessions.mockReturnValue([]);
      mockClaudeManager.getSessionId.mockReturnValue(GUID);

      const interaction = resumeInteraction(GUID);
      await commandHandler.handleInteraction(interaction);

      expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
      expect(mockClaudeManager.pauseSession).not.toHaveBeenCalled();
      expect(mockClaudeManager.setSessionFromAdopt).not.toHaveBeenCalled();
    });
  });
});
