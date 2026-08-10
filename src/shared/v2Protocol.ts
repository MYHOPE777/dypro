import type { LiveCommand, LiveEvent, LiveSessionSnapshot } from './v2';
import type { Product } from './types';

export type V2JoinCommand = {
  type: 'session.join';
  sessionId?: string;
  roomId?: string;
  role: 'operator' | 'display';
  actorId?: string;
  token?: string;
  displayAlias?: string;
  presenterId?: string;
};

export type V2ClientCommand = V2JoinCommand | LiveCommand;
export type V2ClientFrame = { requestId: string; command: V2ClientCommand };

export type V2ServerFrame =
  | { type: 'ready'; requestId: string; sessionId: string; products: Product[]; snapshot: LiveSessionSnapshot }
  | { type: 'ack'; requestId: string; sequence: number }
  | { type: 'event'; event: LiveEvent; snapshot: LiveSessionSnapshot }
  | { type: 'error'; requestId?: string; message: string };
