export type EditorOutputCommand = 'pdf' | 'images' | 'html' | 'csv' | 'docx' | 'docs' | 'print' | 'preview';
export type RegisterEditorOutput = (handler: (command: EditorOutputCommand) => Promise<void>) => () => void;
