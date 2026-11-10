import type { BoardConfig } from '@eventlane/board-api';
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

export interface Settings {
  config: BoardConfig;
  /** The selected bus. */
  bus: string;
  /** Polling interval in ms; 0 = paused. */
  refreshMs: number;
  /** Changes after a write, so every list loads again. */
  version: number;
  bump: () => void;
  /** Shows a message at the top of the page. */
  notify: (text: string, tone?: 'good' | 'bad') => void;
}

export const SettingsContext = createContext<Settings | undefined>(undefined);

export function useSettings(): Settings {
  const settings = useContext(SettingsContext);
  if (!settings) throw new Error('SettingsContext is missing');
  return settings;
}
