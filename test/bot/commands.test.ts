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

describe('CommandHandler', () => {
  let commandHandler: CommandHandler;
  const allowedUserId = 'user-123';

  beforeEach(() => {
    commandHandler = new CommandHandler(mockClaudeManager as any, allowedUserId);
    vi.clearAllMocks();
  });

  describe('getCommands', () => {
    it('should return array of slash commands', () => {
      const commands = commandHandler.getCommands();
      expect(commands).toHaveLength(5);
      expect(commands[0]!.name).toBe('clear');
      expect(commands[1]!.name).toBe('kill');
      expect(commands[2]!.name).toBe('model');
      expect(commands[3]!.name).toBe('killall');
      expect(commands[4]!.name).toBe('add');
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
  });
});