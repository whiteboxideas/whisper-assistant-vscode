import OpenAI from 'openai';
import * as vscode from 'vscode';
import { Transcription } from './speech-transcription';

export interface CommandMapping {
  command: string;
  args?: {
    filename?: string;
  };
}

export class CommandMapper {
  private openai: OpenAI;

  constructor(config: { apiKey: string; baseURL: string }) {
    this.openai = new OpenAI(config);
  }

  async mapTranscriptionToCommand(
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
              'You are a helpful assistant that maps user input to VS Code commands. Assume that part of the input indicates the type of command to execute, and any additional part, if present, provides arguments for that command. Interpret and correct typos or slightly incorrect inputs before mapping them.\n\nMap the input to one of the following commands based on intent:\n\n- "workbench.action.quickOpen" (e.g., for opening files or ambiguous input)\n- "workbench.action.files.newUntitledFile" (e.g., for creating a new file)\n- "workbench.action.files.save" (e.g., for saving files)\n- "workbench.action.closeActiveEditor" (e.g., for closing files or editors)\n- "workbench.action.findInFiles" (e.g., for search-related tasks)\n- "references-view.findReferences" (e.g., for finding references in code).\n\nIf the input includes arguments, such as a filename or search term, include them in the appropriate field of the arguments. If no specific command matches, default to "workbench.action.quickOpen" and put the corrected transcription inside the filename field of the arguments. If it is a file name change it to camelCase',
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
              'Execute a VS Code command with optional arguments. Defaults to quickOpen with the transcription if nothing else fits.',
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
                  description: 'The VS Code command to execute.',
                },
                args: {
                  type: 'object',
                  properties: {
                    filename: {
                      type: 'string',
                      description:
                        'The name of the file to open, save, or search for. If no specific command matches, use the corrected transcription.',
                    },
                  },
                  description: 'Optional arguments for the command.',
                },
              },
              required: ['command'],
            },
          },
        ],
        function_call: {
          name: 'executeVSCodeCommand',
        },
        temperature: 0.2,
      });

      if (completion.choices[0]?.message?.function_call?.arguments) {
        const args = JSON.parse(
          completion.choices[0].message.function_call.arguments,
        );
        return args as CommandMapping;
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

  async executeCommand(mapping: CommandMapping): Promise<void> {
    try {
      console.log('Executing command:', mapping);
      await vscode.commands.executeCommand(mapping.command, mapping.args);
    } catch (error) {
      console.error('Error executing VS Code command:', error);
      vscode.window.showErrorMessage('Failed to execute VS Code command');
    }
  }

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
        tools: [
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
                    description:
                      'Optional filename to confirm which file to close',
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
                    description:
                      'Optional symbol name to search for references',
                  },
                },
              },
            },
          },
        ],
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
