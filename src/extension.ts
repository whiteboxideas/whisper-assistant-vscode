import * as vscode from 'vscode';
import * as path from 'path';
import SpeechTranscription, {
  Transcription,
  WhisperModel,
} from './speech-transcription';
import * as fs from 'fs';

interface ExtensionState {
  myStatusBarItem: vscode.StatusBarItem | undefined;
  isRecording: boolean;
  isTranscribing: boolean;
  speechTranscription: SpeechTranscription | undefined;
  workspacePath: string | undefined;
  outputDir: string | undefined;
  recordingStartTime: number | undefined;
  outputChannel?: vscode.OutputChannel;
  recordingProcess: any;
}

export const state: ExtensionState = {
  myStatusBarItem: undefined,
  isRecording: false,
  isTranscribing: false,
  speechTranscription: undefined,
  workspacePath: undefined,
  outputDir: undefined,
  recordingStartTime: undefined,
  recordingProcess: null,
};

export async function activate(context: vscode.ExtensionContext) {
  // Create output channel
  const outputChannel = vscode.window.createOutputChannel('Whisper Assistant');

  // Get the storage path for the extension
  const storagePath = context.globalStorageUri.fsPath;

  // Ensure storage directory exists
  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }

  // Initialize SpeechTranscription with the storage path
  state.speechTranscription = new SpeechTranscription(
    storagePath,
    outputChannel,
  );

  // Check if Sox is installed (we still need this for recording)
  const isSoxInstalled = await state.speechTranscription?.checkIfInstalled(
    'sox',
  );

  if (!isSoxInstalled) {
    vscode.window.showErrorMessage(
      'SoX is not installed. Please install Sox for this extension to work properly.',
    );
  }

  // Initialize the extension regardless of Sox installation
  registerCommands(context);
  initializeStatusBarItem();
  updateStatusBarItem();

  if (state.myStatusBarItem !== undefined) {
    context.subscriptions.push(state.myStatusBarItem);
  }

  console.log(
    'Congratulations, your extension "Whisper Assistant" is now active!',
  );
}

export function initializeStatusBarItem(): void {
  // create a new status bar item that we can now manage
  state.myStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1,
  );
  state.myStatusBarItem.command = 'whisperAssistant.toggleRecording';
  state.myStatusBarItem.show(); // Make sure the status bar item is shown
}

export function initializeWorkspace(): void {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders !== undefined) {
    state.workspacePath = workspaceFolders[0].uri.fsPath;
    const whisperDir = `${state.workspacePath}/.whisper`;
    if (!fs.existsSync(whisperDir)) {
      fs.mkdirSync(whisperDir);
    }
    state.outputDir = `${state.workspacePath}/.whisper`;
  }
}

function registerCommands(context: vscode.ExtensionContext): void {
  let toggleRecordingDisposable = vscode.commands.registerCommand(
    'whisperAssistant.toggleRecording',
    toggleRecordingCommand,
  );
  context.subscriptions.push(toggleRecordingDisposable);
}

export async function toggleRecordingCommand(): Promise<void> {
  if (state.speechTranscription !== undefined && !state.isTranscribing) {
    const config = vscode.workspace.getConfiguration('whisper-assistant');
    const recordingState = config.get('recordingState') || 'testing';

    if (!state.isRecording) {
      state.speechTranscription.startRecording();
      state.recordingStartTime = Date.now();
      state.isRecording = true;
      updateStatusBarItem();

      if (recordingState === 'testing') {
        // In testing mode, immediately proceed with transcription
        state.isRecording = false;
        state.isTranscribing = true;
        updateStatusBarItem();

        const progressOptions = {
          location: vscode.ProgressLocation.Notification,
          cancellable: false,
          title: 'Transcribing using Test Recording',
        };

        try {
          await vscode.window.withProgress(
            progressOptions,
            async (progress) => {
              const incrementData = initializeIncrementData();
              const interval = startProgressInterval(
                progress,
                incrementData,
                'Processing test recording',
              );

              try {
                if (state.speechTranscription !== undefined) {
                  const transcription: Transcription | undefined =
                    await state.speechTranscription.transcribeRecording();

                  if (transcription) {
                    await vscode.env.clipboard.writeText(transcription.text);
                  }
                }
              } catch (error) {
                progress.report({
                  increment: 0,
                  message: 'Transcription failed',
                });
                throw error;
              }

              await finalizeProgress(progress, interval, incrementData);
            },
          );
        } catch (error) {
          if (state.myStatusBarItem) {
            state.myStatusBarItem.text = '$(error) Transcription failed';
            setTimeout(() => updateStatusBarItem(), 3000);
          }
        } finally {
          state.isTranscribing = false;
          state.recordingStartTime = undefined;
          updateStatusBarItem();
        }
      }
    } else if (recordingState !== 'testing') {
      // Only handle stop recording for non-testing modes
      await state.speechTranscription.stopRecording();
      state.isTranscribing = true;
      state.isRecording = false;

      updateStatusBarItem();

      // Get the current API provider
      const provider = config.get<string>('apiProvider') || 'openai';
      const message = `Transcribing using ${
        provider.charAt(0).toUpperCase() + provider.slice(1)
      } API`;

      const progressOptions = {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: message,
      };

      try {
        await vscode.window.withProgress(progressOptions, async (progress) => {
          const incrementData = initializeIncrementData();
          const interval = startProgressInterval(
            progress,
            incrementData,
            message,
          );

          try {
            if (state.speechTranscription !== undefined) {
              const transcription: Transcription | undefined =
                await state.speechTranscription.transcribeRecording();

              if (transcription) {
                await vscode.env.clipboard.writeText(transcription.text);
                // await vscode.commands.executeCommand(
                //   'editor.action.clipboardPasteAction',
                // );
              }
            }
          } catch (error) {
            progress.report({
              increment: 0,
              message: 'Transcription failed',
            });
            throw error; // Re-throw to handle in outer catch
          }

          await finalizeProgress(progress, interval, incrementData);
        });
      } catch (error) {
        // Handle any errors here
        if (state.myStatusBarItem) {
          state.myStatusBarItem.text = '$(error) Transcription failed';
          setTimeout(() => updateStatusBarItem(), 3000);
        }
      } finally {
        // Always cleanup, but preserve the files
        if (state.speechTranscription !== undefined) {
          state.speechTranscription.deleteFiles(true);
        }
        state.isTranscribing = false;
        state.recordingStartTime = undefined;
        updateStatusBarItem();
      }
    }
  }
}

function updateStatusBarItem(): void {
  if (state.myStatusBarItem === undefined) {
    return;
  }

  if (state.isRecording && state.recordingStartTime !== undefined) {
    const recordingDuration = Math.floor(
      (Date.now() - state.recordingStartTime) / 1000,
    );
    const minutes = Math.floor(recordingDuration / 60);
    const seconds = recordingDuration % 60;
    state.myStatusBarItem.text = `$(stop) ${minutes}:${
      seconds < 10 ? '0' + seconds : seconds
    }`;
  } else {
    state.myStatusBarItem.text = state.isTranscribing
      ? `$(loading~spin)`
      : `$(quote)`;
  }
}

function initializeIncrementData(): {
  increment: number;
  incrementInterval: number;
} {
  let increment: number = 0;
  const recordingDuration: number = state.recordingStartTime
    ? (Date.now() - state.recordingStartTime) / 1000
    : 0;
  const secondsDuration: number = recordingDuration % 60;
  const transcriptionTime: number = secondsDuration * 0.2 + 10; // 20% of the recording time + 10 seconds
  const incrementInterval: number = transcriptionTime * 30; // interval time to increment the progress bar
  return { increment, incrementInterval };
}

function startProgressInterval(
  progress: vscode.Progress<{ increment: number; message: string }>,
  incrementData: { increment: number; incrementInterval: number },
  message: string,
): NodeJS.Timeout {
  const interval = setInterval(() => {
    incrementData.increment += 1;

    progress.report({
      increment: incrementData.increment,
      message: '',
    });
  }, incrementData.incrementInterval);

  return interval;
}

async function finalizeProgress(
  progress: vscode.Progress<{ increment: number; message: string }>,
  interval: NodeJS.Timeout,
  incrementData: { increment: number; incrementInterval: number },
): Promise<void> {
  clearInterval(interval);

  progress.report({
    increment: 100,
    message: 'Text has been saved to the clipboard.',
  });

  state.isTranscribing = false;
  state.recordingStartTime = undefined;
  updateStatusBarItem();
  await new Promise<void>((resolve) => setTimeout(resolve, 2500));
}

// This method is called when your extension is deactivated
export function deactivate() {
  // Dispose the status bar item
  if (state.myStatusBarItem) {
    state.myStatusBarItem.dispose();
  }

  // Cleanup temporary files
  if (state.speechTranscription) {
    state.speechTranscription.cleanup();
  }

  // Reset variables
  state.isRecording = false;
  state.isTranscribing = false;
  state.speechTranscription = undefined;
  state.workspacePath = undefined;
  state.outputDir = undefined;
  state.recordingStartTime = undefined;

  // Log the deactivation
  console.log('Your extension "Whisper Assistant" is now deactivated');
}

export function initializeOutputChannel(): void {
  state.outputChannel = vscode.window.createOutputChannel('Whisper Assistant');
}
