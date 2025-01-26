import * as vscode from 'vscode';
import { exec, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import OpenAI from 'openai';

const execAsync = promisify(exec);

interface Segment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  tokens: number[];
  temperature: number;
}

export interface Transcription {
  text: string;
  segments: Segment[];
  language: string;
}

export type WhisperModel = 'whisper-1' | 'whisper-large-v3-turbo';

type ApiProvider = 'localhost' | 'openai' | 'groq';

interface ApiConfig {
  baseURL: string;
  apiKey: string;
}

const PROVIDER_MODELS: Record<ApiProvider, WhisperModel> = {
  openai: 'whisper-1',
  groq: 'whisper-large-v3-turbo',
  localhost: 'whisper-1', // default to OpenAI model for localhost
};

interface CommandObject {
  command: string;
  args: (string | undefined)[];
}

class SpeechTranscription {
  private fileName: string = 'recording';
  private recordingProcess: ChildProcess | null = null;
  private openai: OpenAI;
  private tempDir: string;

  constructor(
    private storagePath: string,
    private outputChannel: vscode.OutputChannel,
  ) {
    const config = this.getApiConfig();
    this.openai = new OpenAI(config);

    // Create a temp directory within the storage path
    this.tempDir = path.join(this.storagePath, 'temp');
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  private getApiConfig(): ApiConfig {
    const config = vscode.workspace.getConfiguration('whisper-assistant');
    const provider = config.get<ApiProvider>('apiProvider') || 'openai';

    const apiKey = config.get<string>('apiKey');
    if (!apiKey) {
      throw new Error(`API key not configured for ${provider}`);
    }

    const baseURLs: Record<ApiProvider, string> = {
      localhost:
        (config.get('customEndpoint') || 'http://localhost:4444') + '/v1',
      openai: 'https://api.openai.com/v1',
      groq: 'https://api.groq.com/openai/v1',
    };

    return {
      baseURL: baseURLs[provider],
      apiKey,
    };
  }

  async checkIfInstalled(command: string): Promise<boolean> {
    try {
      await execAsync(`${command} --help`);
      return true;
    } catch (error) {
      return false;
    }
  }

  getOutputDir(): string {
    return this.storagePath;
  }

  startRecording(): void {
    try {
      const outputPath = path.join(this.tempDir, `${this.fileName}.wav`);
      this.recordingProcess = exec(
        `sox -d -b 16 -e signed -c 1 -r 16k "${outputPath}"`,
        (error, stdout, stderr) => {
          if (error) {
            this.outputChannel.appendLine(`Whisper Assistant: error: ${error}`);
            return;
          }
          if (stderr) {
            this.outputChannel.appendLine(
              `Whisper Assistant: SoX process has been killed: ${stderr}`,
            );
            return;
          }
          this.outputChannel.appendLine(`Whisper Assistant: stdout: ${stdout}`);
        },
      );
    } catch (error) {
      this.outputChannel.appendLine(`Whisper Assistant: error: ${error}`);
    }
  }

  async stopRecording(): Promise<void> {
    if (!this.recordingProcess) {
      this.outputChannel.appendLine(
        'Whisper Assistant: No recording process found',
      );
      return;
    }
    this.outputChannel.appendLine('Whisper Assistant: Stopping recording');
    this.recordingProcess.kill();
    this.recordingProcess = null;
  }

  async processRecording(): Promise<Transcription | undefined> {
    try {
      const config = vscode.workspace.getConfiguration('whisper-assistant');
      const provider = config.get<ApiProvider>('apiProvider') || 'openai';

      this.outputChannel.appendLine(
        `Whisper Assistant: Transcribing recording using ${provider} API`,
      );

      const audioFile = fs.createReadStream(
        path.join(this.tempDir, `${this.fileName}.wav`),
      );

      const model = PROVIDER_MODELS[provider];

      // First get raw transcription
      const transcription = await this.openai.audio.transcriptions.create({
        file: audioFile,
        model: model,
        language: 'en',
        response_format: 'verbose_json',
      });

      this.outputChannel.appendLine(
        `Whisper Assistant: Transcription raw: ${transcription.text}`,
      );

      // Then process through chat completion to interpret as command
      const completion =
        transcription.text.length > 2 &&
        (await this.openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: 'Convert input to VS Code commands.',
            },
            {
              role: 'user',
              content: transcription.text,
            },
          ],
          functions: [
            {
              name: 'executeVSCodeCommand',
              description:
                'Execute a VS Code command with optional arguments,default to quickOpen with the transcription if nothing else fits',
              parameters: {
                type: 'object',
                properties: {
                  command: {
                    type: 'string',
                    enum: [
                      'workbench.action.quickOpen',
                      'workbench.action.files.newUntitledFile',
                      'workbench.action.files.save',
                      'workbench.action.closeActiveEditor',
                      'workbench.action.findInFiles',
                      'references-view.findReferences',
                    ],
                    description: 'The VS Code command to execute',
                  },
                  args: {
                    type: 'object',
                    properties: {
                      filename: { type: 'string' },
                      searchTerm: { type: 'string' },
                    },
                    description: 'Optional arguments for the command',
                  },
                },
                required: ['command'],
              },
            },
          ],
          function_call: { name: 'executeVSCodeCommand' },
          temperature: 0.2,
        }));

      const functionCall = completion?.choices[0]?.message?.function_call;
      let processedText = 'none';
      let commandObject = { command: '', args: [] };

      if (functionCall?.arguments) {
        try {
          const args = JSON.parse(functionCall.arguments);
          processedText = `${args.command}${
            args.args ? ` ${JSON.stringify(args.args)}` : ''
          }`;
          commandObject = {
            command: args.command,
            args: [args.args?.filename, args.args?.searchTerm].filter(Boolean),
          };
        } catch (error) {
          this.outputChannel.appendLine(
            `Whisper Assistant: Error parsing function arguments: ${error}`,
          );
        }
      }

      // Convert response to our Transcription interface
      const result: Transcription = {
        text: processedText,
        segments:
          transcription.segments?.map((seg) => ({
            id: seg.id,
            seek: 0,
            start: seg.start,
            end: seg.end,
            text: seg.text,
            tokens: [],
            temperature: 0,
          })) ?? [],
        language: transcription.language,
      };

      // Process the transcription to map to VS Code commands

      if (commandObject.command) {
        try {
          this.outputChannel.appendLine(
            `Whisper Assistant: Executing command ${
              commandObject.command
            } with args: ${JSON.stringify(commandObject.args)}`,
          );
          await vscode.commands.executeCommand(
            commandObject.command,
            ...commandObject.args,
          );
        } catch (error) {
          this.outputChannel.appendLine(
            `Whisper Assistant: Error executing command: ${error}`,
          );
        }
      }

      // Save transcription to storage path
      await fs.promises.writeFile(
        path.join(this.tempDir, `${this.fileName}.json`),
        JSON.stringify(result, null, 2),
      );

      this.outputChannel.appendLine(
        `Whisper Assistant: Transcription: ${result.text}`,
      );

      if (result?.text?.length === 0) {
        return undefined;
      }

      return result;
    } catch (error) {
      // Log the error to output channel
      this.outputChannel.appendLine(`Whisper Assistant: error: ${error}`);

      // Show error message to user
      let errorMessage = 'An error occurred during transcription.';

      if (error instanceof Error) {
        // Format the error message to be more user-friendly
        errorMessage = error.message
          .replace(/\bError\b/i, '') // Remove redundant "Error" word
          .trim();
      }

      vscode.window.showErrorMessage(`Whisper Assistant: ${errorMessage}`);
      return undefined;
    }
  }

  // Add cleanup method for extension deactivation
  cleanup(): void {
    try {
      if (fs.existsSync(this.tempDir)) {
        fs.rmSync(this.tempDir, { recursive: true, force: true });
      }
    } catch (error) {
      this.outputChannel.appendLine(
        `Whisper Assistant: Error cleaning up: ${error}`,
      );
    }
  }
}

export default SpeechTranscription;
