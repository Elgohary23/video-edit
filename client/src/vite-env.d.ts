/// <reference types="vite/client" />

interface Window {
  /**
   * File System Access API save dialog (Chromium-family only). Not part of
   * lib.dom; optional so unsupported browsers can be feature-detected.
   */
  showSaveFilePicker?: (options?: {
    suggestedName?: string
    types?: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<FileSystemFileHandle>
}
