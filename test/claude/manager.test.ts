import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  ClaudeManager,
  apiRetryDelayMs,
  isApiErrorText,
  resolveModelAlias,
  DEFAULT_MODEL,
  LEGACY_SESSION_MODEL,
} from '../../src/claude/manager.js';
import * as fs from 'fs';
import * as path from 'path';

describe('API-error auto-resume helpers', () => {
  describe('apiRetryDelayMs', () => {
    it('follows the escalating schedule: 10s, 20s, 30s, 60s, then +60s each', () => {
      expect(apiRetryDelayMs(0)).toBe(10_000);
      expect(apiRetryDelayMs(1)).toBe(20_000);
      expect(apiRetryDelayMs(2)).toBe(30_000);
      expect(apiRetryDelayMs(3)).toBe(60_000);
      expect(apiRetryDelayMs(4)).toBe(120_000);
      expect(apiRetryDelayMs(5)).toBe(180_000);
    });

    it('caps at 10 minutes and stays there forever', () => {
      expect(apiRetryDelayMs(12)).toBe(600_000); // 60 + (12-3)*60 = 600s
      expect(apiRetryDelayMs(13)).toBe(600_000);
      expect(apiRetryDelayMs(100)).toBe(600_000);
    });
  });

  describe('resolveModelAlias', () => {
    it('pins bare tier aliases to a concrete version', () => {
      expect(resolveModelAlias('opus')).toBe('claude-opus-5');
      expect(resolveModelAlias('sonnet')).toBe('claude-sonnet-5');
      expect(resolveModelAlias('haiku')).toBe('claude-haiku-4-5');
    });

    it('leaves explicit model IDs alone', () => {
      expect(resolveModelAlias('claude-opus-4-8')).toBe('claude-opus-4-8');
      expect(resolveModelAlias('claude-opus-5')).toBe('claude-opus-5');
    });
  });

  describe('isApiErrorText', () => {
    it('matches known API-error signatures (case-insensitive)', () => {
      expect(isApiErrorText('API Error: Connection closed mid-response.')).toBe(true);
      expect(isApiErrorText('Unable to connect to API')).toBe(true);
      expect(isApiErrorText('overloaded_error')).toBe(true);
      expect(isApiErrorText('Request timed out')).toBe(true);
      expect(isApiErrorText('ECONNRESET')).toBe(true);
    });

    it('ignores normal output and empty input', () => {
      expect(isApiErrorText('Task completed successfully')).toBe(false);
      expect(isApiErrorText('')).toBe(false);
      expect(isApiErrorText(undefined)).toBe(false);
      expect(isApiErrorText(null)).toBe(false);
    });
  });
});

vi.mock('fs');
vi.mock('child_process');

// Mock bun:sqlite first
vi.mock('bun:sqlite', () => ({
  Database: vi.fn()
}));

vi.mock('../../src/db/database.js', () => ({
  DatabaseManager: vi.fn()
}));

describe('ClaudeManager', () => {
  let manager: ClaudeManager;
  let mockDb: any;
  const mockBaseFolder = '/test/base';

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Mock the DatabaseManager
    const { DatabaseManager } = await import('../../src/db/database.js');
    mockDb = {
      getSession: vi.fn(),
      setSession: vi.fn(),
      getSessionModel: vi.fn(),
      setSessionModel: vi.fn(),
      clearSession: vi.fn(),
      getAllSessions: vi.fn().mockReturnValue([]),
      cleanupOldSessions: vi.fn(),
      updateSessionSummary: vi.fn(),
      markRunStarted: vi.fn(),
      markRunCompleted: vi.fn(),
      getInterruptedRuns: vi.fn().mockReturnValue([]),
      clearAllActiveRuns: vi.fn(),
      addTodo: vi.fn(),
      getTodos: vi.fn().mockReturnValue([]),
      getChannelAndChildTodos: vi.fn().mockReturnValue([]),
      completeTodo: vi.fn(),
      uncompleteTodo: vi.fn(),
      clearCompletedTodos: vi.fn().mockReturnValue(0),
      addPromptHistory: vi.fn(),
      getPromptHistory: vi.fn().mockReturnValue([]),
      getPausedSession: vi.fn(),
      deletePausedSession: vi.fn(),
      addSessionCost: vi.fn(),
      setSessionResumedFrom: vi.fn(),
      close: vi.fn()
    };
    vi.mocked(DatabaseManager).mockImplementation(() => mockDb);
    
    manager = new ClaudeManager(mockBaseFolder);
  });

  afterEach(() => {
    manager.destroy();
    vi.restoreAllMocks();
  });

  describe('getModelForRun', () => {
    it('starts a brand-new session on the current default', () => {
      mockDb.getSessionModel.mockReturnValue(undefined);
      mockDb.getSession.mockReturnValue(undefined);
      expect(manager.getModelForRun('channel-1')).toBe(DEFAULT_MODEL);
    });

    it('resumes a session created before pinning on the legacy model', () => {
      // session_model IS NULL but a session exists: it predates pinning, so it
      // keeps running on what it was created under rather than jumping forward.
      mockDb.getSessionModel.mockReturnValue(undefined);
      mockDb.getSession.mockReturnValue('sess-old');
      expect(manager.getModelForRun('channel-1')).toBe(LEGACY_SESSION_MODEL);
    });

    it('keeps a pinned session on its model even when the channel default moves', () => {
      mockDb.getSessionModel.mockReturnValue('claude-opus-5');
      mockDb.getSession.mockReturnValue('sess-new');
      manager.setModel('channel-1', 'claude-sonnet-5');
      expect(manager.getModelForRun('channel-1')).toBe('claude-opus-5');
    });

    it('resolves a stale bare alias before it can be pinned', () => {
      mockDb.getSessionModel.mockReturnValue(undefined);
      mockDb.getSession.mockReturnValue(undefined);
      manager.setModel('channel-1', 'opus');
      expect(manager.getModelForRun('channel-1')).toBe('claude-opus-5');
    });

    it('repins the live session when /model is used explicitly', () => {
      mockDb.getSession.mockReturnValue('sess-live');
      manager.setModel('channel-1', 'opus');
      // The alias is resolved on the way in, so the pin can't float later.
      expect(mockDb.setSessionModel).toHaveBeenCalledWith('channel-1', 'claude-opus-5');
    });

    it('does not repin when the channel has no session yet', () => {
      mockDb.getSession.mockReturnValue(undefined);
      manager.setModel('channel-1', 'claude-opus-4-8');
      expect(mockDb.setSessionModel).not.toHaveBeenCalled();
    });
  });

  describe('resumeSession', () => {
    it('remembers the name it was resumed from', () => {
      mockDb.getPausedSession.mockReturnValue({
        channelId: 'channel-1', name: 'refactor-queue', sessionId: 'sess-1',
        pausedAt: 1, totalCostUsd: 0, isResumable: true,
      });

      expect(manager.resumeSession('channel-1', 'refactor-queue', 'proj')).toBe(true);
      expect(mockDb.setSessionResumedFrom).toHaveBeenCalledWith('channel-1', 'refactor-queue');
    });

    it('records no name for a session parked under its own id', () => {
      mockDb.getPausedSession.mockReturnValue({
        channelId: 'channel-1', name: 'sess-1', sessionId: 'sess-1',
        pausedAt: 1, totalCostUsd: 0, isResumable: true,
      });

      manager.resumeSession('channel-1', 'sess-1', 'proj');
      expect(mockDb.setSessionResumedFrom).not.toHaveBeenCalled();
    });
  });

  describe('hasActiveProcess', () => {
    it('should return false when no active process exists', () => {
      expect(manager.hasActiveProcess('channel-1')).toBe(false);
    });

    it('should return true when active process exists', () => {
      manager.reserveChannel('channel-1', undefined, {});
      expect(manager.hasActiveProcess('channel-1')).toBe(true);
    });
  });

  describe('killActiveProcess', () => {
    it('should kill process when it exists', () => {
      const mockProcess = { kill: vi.fn() };
      manager.reserveChannel('channel-1', undefined, {});
      
      // Simulate setting the process
      const channelProcesses = (manager as any).channelProcesses;
      channelProcesses.get('channel-1').process = mockProcess;

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      
      manager.killActiveProcess('channel-1');
      
      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(consoleSpy).toHaveBeenCalledWith('Killing active process for channel channel-1');
      
      consoleSpy.mockRestore();
    });

    it('should not throw when no process exists', () => {
      expect(() => manager.killActiveProcess('nonexistent')).not.toThrow();
    });
  });

  describe('clearSession', () => {
    it('should clear all session data', () => {
      manager.reserveChannel('channel-1', 'session-1', {});
      manager.setDiscordMessage('channel-1', { edit: vi.fn() });
      
      manager.clearSession('channel-1');
      
      expect(manager.hasActiveProcess('channel-1')).toBe(false);
      expect(mockDb.clearSession).toHaveBeenCalledWith('channel-1');
    });
  });

  describe('setDiscordMessage', () => {
    it('should set discord message and initialize responses', () => {
      const mockMessage = { edit: vi.fn() };
      manager.setDiscordMessage('channel-1', mockMessage);
      
      const channelMessages = (manager as any).channelMessages;
      const channelToolCalls = (manager as any).channelToolCalls;

      expect(channelMessages.get('channel-1')).toBe(mockMessage);
      expect(channelToolCalls.get('channel-1')).toEqual(new Map());
    });
  });

  describe('reserveChannel', () => {
    it('should reserve channel without existing process', () => {
      const mockMessage = { edit: vi.fn() };
      manager.reserveChannel('channel-1', 'session-1', mockMessage);
      
      expect(manager.hasActiveProcess('channel-1')).toBe(true);
      // Note: reserveChannel sets the sessionId in the process object, not channelSessions
      // The sessionId is only set in channelSessions when Claude actually responds
    });

    it('keeps a live process alive and repoints it at the new turn', () => {
      // The channel's process outlives its turns so background watchers survive.
      // Killing it here is what used to take them down — runClaudeCode decides
      // whether to inject into it or retire it deliberately.
      const mockExistingProcess = { kill: vi.fn() };
      const mockMessage = { edit: vi.fn() };
      const newMessage = { edit: vi.fn() };

      manager.reserveChannel('channel-1', undefined, mockMessage);
      const channelProcesses = (manager as any).channelProcesses;
      channelProcesses.get('channel-1').process = mockExistingProcess;

      manager.reserveChannel('channel-1', 'new-session', newMessage);

      expect(mockExistingProcess.kill).not.toHaveBeenCalled();
      expect(channelProcesses.get('channel-1').process).toBe(mockExistingProcess);
      expect(channelProcesses.get('channel-1').sessionId).toBe('new-session');
      expect(channelProcesses.get('channel-1').discordMessage).toBe(newMessage);
    });
  });

  describe('turn vs process liveness', () => {
    it('reports a live process between turns as not busy', () => {
      manager.reserveChannel('channel-1', undefined, {});
      const entry = (manager as any).channelProcesses.get('channel-1');
      entry.process = { kill: vi.fn() };
      entry.turnActive = false;

      // A process kept warm for the next prompt (or holding a watcher) is not a
      // turn in flight — /kill and the dashboard need to tell those apart.
      expect(manager.hasActiveProcess('channel-1')).toBe(false);
      expect(manager.hasLiveProcess('channel-1')).toBe(true);
    });

    it('reports a process mid-turn as busy', () => {
      manager.reserveChannel('channel-1', undefined, {});
      const entry = (manager as any).channelProcesses.get('channel-1');
      entry.process = { kill: vi.fn() };
      entry.turnActive = true;

      expect(manager.hasActiveProcess('channel-1')).toBe(true);
      expect(manager.hasLiveProcess('channel-1')).toBe(true);
    });
  });

  describe('reusing a live process for the next turn', () => {
    // `once("close")` resolves immediately: shutdownProcess waits for the real
    // event, and a mock that never fires it would sit through the SIGTERM
    // escalation instead of exercising the respawn.
    const mockProcess = () => ({
      pid: 999,
      stdin: { end: vi.fn(), write: vi.fn(), writable: true },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      once: vi.fn((event: string, cb: (code: number) => void) => {
        if (event === 'close') setImmediate(() => cb(0));
      }),
      kill: vi.fn(),
    });

    /** Park a live, idle process on the channel as a previous turn would leave it. */
    function parkProcess(overrides: Record<string, any> = {}) {
      manager.reserveChannel('channel-1', 'session-1', {});
      const entry = (manager as any).channelProcesses.get('channel-1');
      Object.assign(entry, {
        process: mockProcess(),
        spec: { model: DEFAULT_MODEL, planMode: false, workingDir: path.join(mockBaseFolder, 'test-channel') },
        runningSessionId: 'session-1',
        turnActive: false,
        startedAt: Date.now(),
        ...overrides,
      });
      (manager as any).streamingChannels.add('channel-1');
      (manager as any).channelNames.set('channel-1', 'test-channel');
      vi.mocked(fs.existsSync).mockReturnValue(true);
      mockDb.getSessionModel.mockReturnValue(DEFAULT_MODEL);
      mockDb.getSession.mockReturnValue('session-1');
      return entry;
    }

    it('injects the prompt instead of spawning a second process', async () => {
      const entry = parkProcess();
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockClear();

      await manager.runClaudeCode('channel-1', 'test-channel', 'next prompt', 'session-1');

      expect(spawn).not.toHaveBeenCalled();
      expect(entry.process.stdin.write).toHaveBeenCalled();
      const written = vi.mocked(entry.process.stdin.write).mock.calls[0]![0] as string;
      expect(written).toContain('next prompt');
      expect(entry.turnActive).toBe(true);
    });

    it('refuses to inject into a process running a different session', async () => {
      // /resume repoints the channel; the parked process still holds the old
      // conversation, so the prompt must not be written into it.
      const entry = parkProcess({ runningSessionId: 'session-OLD' });
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(mockProcess() as any);

      await manager.runClaudeCode('channel-1', 'test-channel', 'next prompt', 'session-1');

      expect(entry.process.stdin.write).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalled();
    });

    it('refuses to inject when the model was repinned under it', async () => {
      const entry = parkProcess({
        spec: { model: 'claude-sonnet-5', planMode: false, workingDir: path.join(mockBaseFolder, 'test-channel') },
      });
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(mockProcess() as any);

      await manager.runClaudeCode('channel-1', 'test-channel', 'next prompt', 'session-1');

      expect(entry.process.stdin.write).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalled();
    });

    it('refuses to inject a raw CLI command — its content lives in argv', async () => {
      const entry = parkProcess();
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(mockProcess() as any);

      await manager.runClaudeCode('channel-1', 'test-channel', '--version', 'session-1');

      expect(entry.process.stdin.write).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalled();
    });
  });

  describe('hasActiveWatchers', () => {
    it('is false with no process and false with an empty task list', () => {
      expect(manager.hasActiveWatchers('channel-1')).toBe(false);
      manager.reserveChannel('channel-1', undefined, {});
      expect(manager.hasActiveWatchers('channel-1')).toBe(false);
    });

    it('tracks the CLI\'s background_tasks_changed snapshot wholesale', () => {
      manager.reserveChannel('channel-1', undefined, {});
      const update = (manager as any).updateLiveTasks.bind(manager);

      update('channel-1', [{ task_id: 'a' }, { task_id: 'b' }]);
      expect(manager.hasActiveWatchers('channel-1')).toBe(true);

      // A snapshot, not a delta: an empty list means nothing is running, however
      // many terminal statuses we did or didn't recognise along the way.
      update('channel-1', []);
      expect(manager.hasActiveWatchers('channel-1')).toBe(false);
    });
  });

  describe('getSessionId', () => {
    it('should return undefined when no session exists', () => {
      mockDb.getSession.mockReturnValue(undefined);
      expect(manager.getSessionId('channel-1')).toBeUndefined();
      expect(mockDb.getSession).toHaveBeenCalledWith('channel-1');
    });

    it('should return session ID when it exists', () => {
      mockDb.getSession.mockReturnValue('session-123');
      
      expect(manager.getSessionId('channel-1')).toBe('session-123');
      expect(mockDb.getSession).toHaveBeenCalledWith('channel-1');
    });
  });

  describe('runClaudeCode', () => {
    it('should throw error when working directory does not exist', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      
      await expect(
        manager.runClaudeCode('channel-1', 'test-channel', 'test prompt')
      ).rejects.toThrow(`Working directory does not exist: ${path.join(mockBaseFolder, 'test-channel')}`);
    });

    it('should set up process when directory exists', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      
      const mockProcess = {
        pid: 12345,
        stdin: { end: vi.fn(), write: vi.fn(), writable: true },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn()
      };
      
      // Mock spawn from child_process module
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(mockProcess as any);
      
      manager.reserveChannel('channel-1', undefined, {});
      
      // Start the process and immediately resolve to avoid hanging
      try {
        await manager.runClaudeCode('channel-1', 'test-channel', 'test prompt');
      } catch (error) {
        // Expected to fail due to mocking, just checking setup
      }
      
      expect(spawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--output-format', 'stream-json']),
        expect.objectContaining({ cwd: path.join(mockBaseFolder, 'test-channel') })
      );
      // Normal text prompts use streaming-input mode: the prompt is written to
      // stdin as a stream-json user message (stdin stays open for /interrupt, /btw).
      expect(mockProcess.stdin.write).toHaveBeenCalled();
      const written = vi.mocked(mockProcess.stdin.write).mock.calls[0]![0] as string;
      expect(written).toContain('"type":"user"');
      expect(written).toContain('test prompt');
    });
  });

  describe('mid-turn inactivity reaper', () => {
    const CHANNEL = 'channel-reaper';
    let reaped: any;

    // Stand in for a live CLI process mid-turn with nothing to show for itself.
    function armSilentTurn(overrides: Partial<{ liveTasks: Set<string>; startedAt: number }> = {}) {
      const entry = {
        process: { pid: 999, kill: vi.fn(), exitCode: null, signalCode: null, stdin: { end: vi.fn() } },
        turnActive: true,
        liveTasks: new Set<string>(),
        startedAt: Date.now(),
        inactivityTimer: undefined as any,
        ...overrides,
      };
      (manager as any).channelProcesses.set(CHANNEL, entry);
      return entry;
    }

    beforeEach(() => {
      vi.useFakeTimers();
      // The reaper's action, stubbed: we're asserting the decision, not the kill.
      reaped = vi.spyOn(manager as any, 'handleProcessTimeout').mockImplementation(() => {});
    });

    afterEach(() => {
      (manager as any).channelProcesses.delete(CHANNEL);
      vi.useRealTimers();
    });

    it('reaps a turn that has gone silent with nothing outstanding', () => {
      armSilentTurn();
      (manager as any).onInactivity(CHANNEL);
      expect(reaped).toHaveBeenCalledWith(CHANNEL, expect.anything());
    });

    it('spares a turn blocked on the user — an unanswered question makes no output', () => {
      manager.setPendingUserPromptProbe((id) => id === CHANNEL);
      const entry = armSilentTurn();

      (manager as any).onInactivity(CHANNEL);

      expect(reaped).not.toHaveBeenCalled();
      // …and re-arms, so it reaps later if the wait resolves into a real hang.
      expect(entry.inactivityTimer).toBeDefined();
    });

    it('spares a turn blocked on a background task', () => {
      armSilentTurn({ liveTasks: new Set(['task-1']) });
      (manager as any).onInactivity(CHANNEL);
      expect(reaped).not.toHaveBeenCalled();
    });

    it('reaps once the wait outlives the absolute hold cap', () => {
      manager.setPendingUserPromptProbe(() => true);
      armSilentTurn({ startedAt: Date.now() - 7 * 3600 * 1000 }); // past the 6h ceiling

      (manager as any).onInactivity(CHANNEL);

      expect(reaped).toHaveBeenCalled();
    });

    it('ignores a channel whose turn already ended', () => {
      manager.setPendingUserPromptProbe(() => false);
      const entry = armSilentTurn();
      entry.turnActive = false;

      (manager as any).onInactivity(CHANNEL);

      expect(reaped).not.toHaveBeenCalled();
    });
  });

  describe('database integration', () => {
    it('should initialize database and cleanup old sessions on construction', () => {
      // The cleanupOldSessions call happens during construction, so we need to check
      // if it was called when the manager was created in beforeEach
      expect(mockDb.cleanupOldSessions).toHaveBeenCalled();
    });

    it('should close database on destroy', () => {
      manager.destroy();
      expect(mockDb.close).toHaveBeenCalled();
    });
  });
});