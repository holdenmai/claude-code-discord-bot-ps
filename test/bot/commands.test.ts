import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CommandHandler } from '../../src/bot/commands.js';

// Mock ClaudeManager
const mockClaudeManager = {
  clearSession: vi.fn(),
  hasActiveProcess: vi.fn(),
  killActiveProcess: vi.fn(),
  killAllProcesses: vi.fn().mockReturnValue(0),
  setModel: vi.fn(),
  getModel: vi.fn().mockReturnValue('sonnet'),
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
      expect(commands).toHaveLength(10);
      expect(commands[0]!.name).toBe('clear');
      expect(commands[1]!.name).toBe('kill');
      expect(commands[2]!.name).toBe('model');
      expect(commands[3]!.name).toBe('killall');
      expect(commands[4]!.name).toBe('add');
      expect(commands[5]!.name).toBe('plan');
      expect(commands[6]!.name).toBe('update');
      expect(commands[7]!.name).toBe('init');
      expect(commands[8]!.name).toBe('shortcut');
      expect(commands[9]!.name).toBe('file');
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
});
