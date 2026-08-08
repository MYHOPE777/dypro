import type { CaptureState } from './shared/types';

type InputDeviceSwitchRuntime = {
  capturing: boolean;
  stop: () => void;
  start: (deviceId: string) => Promise<boolean>;
};

export function canSelectInputDevice(captureState: CaptureState, connected: boolean): boolean {
  return connected && (captureState === 'idle' || captureState === 'paused');
}

export async function switchInputDevice(deviceId: string, runtime: InputDeviceSwitchRuntime): Promise<boolean> {
  if (!runtime.capturing) return true;
  runtime.stop();
  return runtime.start(deviceId);
}
