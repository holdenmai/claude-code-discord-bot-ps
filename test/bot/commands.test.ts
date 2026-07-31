import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandHandler, isSessionGuid } from '../../src/bot/commands.js';

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
      expect(commands).toHaveLength(23);
      expect(commands[0]!.name).toBe('clear');
      expect(commands[1]!.name).toBe('kill');
      expect(commands[2]!.name).toBe('stop');
      expect(commands[3]!.name).toBe('model');
      expect(commands[4]!.name).toBe('killall');
      expect(commands[5]!.name).toBe('add');
      expect(commands[6]!.name).toBe('plan');
      expect(commands[7]!.name).toBe('update');
      expect(commands[8]!.name).toBe('restart');
      expect(commands[9]!.name).toBe('init');
      expect(commands[10]!.name).toBe('shortcut');
      expect(commands[11]!.name).toBe('sync');
      expect(commands[12]!.name).toBe('end');
      expect(commands[13]!.name).toBe('adopt');
      expect(commands[14]!.name).toBe('status');
      expect(commands[15]!.name).toBe('todo');
      expect(commands[16]!.name).toBe('pause');
      expect(commands[17]!.name).toBe('resume');
      expect(commands[18]!.name).toBe('online');
      expect(commands[19]!.name).toBe('costreview');
      expect(commands[20]!.name).toBe('interrupt');
      expect(commands[21]!.name).toBe('btw');
      expect(commands[22]!.name).toBe('file');
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
