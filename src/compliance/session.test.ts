import { describe, expect, it, vi } from 'vitest';
import { LiveSession } from '../../server/session';
import type WebSocket from 'ws';

function fakeSocket() {
  return { readyState: 1, send: () => undefined } as unknown as WebSocket;
}

describe('LiveSession', () => {
  it('uses an unguessable id for a new display session', () => {
    expect(new LiveSession().id).toMatch(/^live-[a-f0-9]{24}$/u);
  });

  it('keeps the selected product as the context for the next compliance result', async () => {
    const session = new LiveSession('test-session');
    session.addClient(fakeSocket(), 'operator');
    session.selectProduct('headphones');
    session.ingestTranscript('这款耳机全网最低价，错过今天就没有了！');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.state.product.id).toBe('headphones');
    expect(session.state.latestCompliance?.productId).toBe('headphones');
    expect(session.state.latestCompliance?.risk).toBe('warning');
    expect(session.state.stats.warningCount).toBe(1);
    expect(session.state.alerts).toHaveLength(1);
  });

  it('enters listening state without provider credentials for a demo session', () => {
    const session = new LiveSession('demo-session');
    session.startListening();
    expect(session.state.isListening).toBe(true);
    session.stopListening();
    expect(session.state.isListening).toBe(false);
  });

  it('keeps capture local and enqueues the archive only after stopping', () => {
    const enqueue = vi.fn();
    const session = new LiveSession('archive-session', { archiveQueue: { enqueue } });

    session.startListening();
    session.ingestAudio(Buffer.from([0, 0]));
    expect(enqueue).not.toHaveBeenCalled();
    session.stopListening();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith('archive-session');
  });
});
