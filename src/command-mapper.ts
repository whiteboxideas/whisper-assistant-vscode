import OpenAI from 'openai';
import * as vscode from 'vscode';
import { Transcription } from './speech-transcription';

export interface CommandMapping {
  command: string;
  args?: {
    filename?: string;
  };
}

type RecordingState = 'regular' | 'testing' | 'new-recording';

export class CommandMapper {
  private openai: OpenAI;
  private recordingState: RecordingState;

  constructor(config: { apiKey: string; baseURL: string }) {
    this.openai = new OpenAI(config);
    const vscodeConfig = vscode.workspace.getConfiguration('whisper-assistant');
    this.recordingState = vscodeConfig.get('recordingState') || 'testing';
  }

  getRecordingState(): RecordingState {
    return this.recordingState;
  }

  async executeCommand(mapping: CommandMapping): Promise<void> {
    try {
      console.log('Executing command:', mapping);
      await vscode.commands.executeCommand(mapping.command, mapping.args);
    } catch (error) {
      console.error('Error executing VS Code command:', error);
      vscode.window.showErrorMessage('Failed to execute VS Code command');
    }
  }

  private VS_CODE_COMMAND_TOOLS = [
    {
      type: 'function',
      function: {
        name: 'quickOpen',
        description:
          'Open the quick open dialog to find files or handle ambiguous input',
        parameters: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description:
                'The filename or search term to pre-fill in quick open',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'newFile',
        description: 'Create a new untitled file',
        parameters: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'Optional filename for the new file',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'saveFile',
        description: 'Save the current file',
        parameters: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'Optional filename to save as',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'closeEditor',
        description: 'Close the current editor or file',
        parameters: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'Optional filename to confirm which file to close',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'findInFiles',
        description: 'Search for text across all files',
        parameters: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'The search term to look for in files',
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'findReferences',
        description:
          'Find all references to the current symbol in the codebase',
        parameters: {
          type: 'object',
          properties: {
            filename: {
              type: 'string',
              description: 'Optional symbol name to search for references',
            },
          },
        },
      },
    },
  ];

  async mapTranscriptionToCommandViaTools(
    transcription: Transcription,
  ): Promise<CommandMapping | undefined> {
    try {
      if (!transcription.text || transcription.text.length <= 2) {
        return undefined;
      }

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful assistant that maps user input to VS Code commands. Interpret and correct typos or slightly incorrect inputs before mapping them to the most appropriate command. If no specific command matches, use quickOpen with the transcription as the filename.',
          },
          {
            role: 'user',
            content: transcription.text,
          },
        ],
        tools: this.VS_CODE_COMMAND_TOOLS,
        temperature: 0.2,
      });

      const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
      if (toolCall?.type === 'function' && toolCall.function.arguments) {
        const args = JSON.parse(toolCall.function.arguments);

        // Map the tool names back to VS Code commands
        const commandMap: Record<string, string> = {
          quickOpen: 'workbench.action.quickOpen',
          newFile: 'workbench.action.files.newUntitledFile',
          saveFile: 'workbench.action.files.save',
          closeEditor: 'workbench.action.closeActiveEditor',
          findInFiles: 'workbench.action.findInFiles',
          findReferences: 'references-view.findReferences',
        };

        return {
          command: commandMap[toolCall.function.name],
          args: args.filename,
        };
      }

      return undefined;
    } catch (error) {
      console.error('Error mapping transcription to command:', error);
      vscode.window.showErrorMessage(
        'Failed to map voice command to VS Code action',
      );
      return undefined;
    }
  }
}
