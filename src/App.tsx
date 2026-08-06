import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleStop,
  ExternalLink,
  Headphones,
  Keyboard,
  Mic,
  Monitor,
  Play,
  Radio,
  ShieldCheck,
  Sparkles,
  Volume2,
  Wifi,
  XCircle,
} from 'lucide-react';
import { DEFAULT_PRODUCT, PRODUCTS } from './shared/products';
import type { ComplianceResult, ServerMessage, SessionState } from './shared/types';

type Role = 'operator' | 'display';

const EMPTY_STATE: SessionState = {
  sessionId: '',
  product: DEFAULT_PRODUCT,
  isListening: false,
  partialTranscript: '',
  transcriptHistory: [],
  latestCompliance: null,
  alerts: [],
  stats: { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 },
  lastEventAt: Date.now(),
};

function useLiveSession(role: Role) {
  const [state, setState] = useState<SessionState>(EMPTY_STATE);
  const [sessionId, setSessionId] = useState(() => new URLSearchParams(window.location.search).get('session') ?? localStorage.getItem('live-session') ?? '');
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('正在连接会话');
  const socketRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let reconnectTimer: number | undefined;
    let disposed = false;
    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socketRef.current = socket;
      socket.onopen = () => {
        setConnected(true);
        socket.send(JSON.stringify({ type: 'session.join', sessionId: sessionId || undefined, role }));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === 'connection.ready') {
          setSessionId(message.sessionId);
          localStorage.setItem('live-session', message.sessionId);
          setStatus('会话已连接');
        } else if (message.type === 'state.snapshot') {
          setState(message.state);
        } else if (message.type === 'transcript.partial') {
          setState((current) => ({ ...current, partialTranscript: message.segment.text }));
        } else if (message.type === 'transcript.final') {
          setState((current) => ({ ...current, partialTranscript: '', transcriptHistory: [...current.transcriptHistory, message.segment].slice(-20) }));
        } else if (message.type === 'system.status') {
          setStatus(message.message);
        } else if (message.type === 'system.error') {
          setStatus(message.message);
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (!disposed) reconnectTimer = window.setTimeout(connect, 1800);
      };
      socket.onerror = () => setStatus('连接暂时不可用，正在重试');
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socketRef.current?.close();
    };
  }, [role, sessionId]);

  const send = useCallback((message: object) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message));
  }, []);

  return { state, sessionId, connected, status, send };
}

function useMicrophone(send: (message: object) => void, isListening: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [error, setError] = useState('');
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    const inputs = list.filter((device) => device.kind === 'audioinput');
    setDevices(inputs);
    if (!deviceId && inputs[0]) setDeviceId(inputs[0].deviceId);
  }, [deviceId]);

  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, [refresh]);

  const stop = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = null;
    contextRef.current?.close();
    contextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    if (!isListening) stop();
    return stop;
  }, [isListening, stop]);

  const start = useCallback(async () => {
    try {
      setError('');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const context = new AudioContext();
      contextRef.current = context;
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const ratio = context.sampleRate / 16000;
        const rawOutput = new Int16Array(input.length);
        for (let index = 0; index < rawOutput.length; index += 1) {
          rawOutput[index] = Math.max(-1, Math.min(1, input[index])) * 0x7fff;
        }
        const rawBytes = new Uint8Array(rawOutput.buffer);
        let rawBinary = '';
        for (const byte of rawBytes) rawBinary += String.fromCharCode(byte);
        send({ type: 'audio.raw', data: btoa(rawBinary), sampleRate: context.sampleRate });
        const output = new Int16Array(Math.floor(input.length / ratio));
        for (let index = 0; index < output.length; index += 1) {
          const value = input[Math.min(input.length - 1, Math.floor(index * ratio))];
          output[index] = Math.max(-1, Math.min(1, value)) * 0x7fff;
        }
        const bytes = new Uint8Array(output.buffer);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        send({ type: 'audio', data: btoa(binary) });
      };
      source.connect(processor);
      const silentSink = context.createGain();
      silentSink.gain.value = 0;
      processor.connect(silentSink);
      silentSink.connect(context.destination);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法访问麦克风');
      send({ type: 'control.stop' });
    }
  }, [deviceId, send]);

  return { devices, deviceId, setDeviceId, start, stop, error, refresh };
}

function RiskIcon({ risk }: { risk: ComplianceResult['risk'] }) {
  if (risk === 'blocked') return <XCircle size={18} strokeWidth={2.4} />;
  if (risk === 'warning') return <AlertTriangle size={18} strokeWidth={2.4} />;
  return <Check size={18} strokeWidth={2.4} />;
}

function RiskLabel({ risk }: { risk: ComplianceResult['risk'] }) {
  return risk === 'blocked' ? '高风险 · 立即替换' : risk === 'warning' ? '需留意 · 建议替换' : '表达可继续';
}

function formatReplayOffset(offsetMs: number | null): string {
  if (offsetMs === null) return '未建立时间基准';
  const hours = Math.floor(offsetMs / 3_600_000);
  const minutes = Math.floor((offsetMs % 3_600_000) / 60_000);
  const seconds = Math.floor((offsetMs % 60_000) / 1_000);
  const milliseconds = offsetMs % 1_000;
  return `+${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')}`;
}

function AppHeader({ state, connected, status, mode }: { state: SessionState; connected: boolean; status: string; mode: Role }) {
  const [lanOrigin, setLanOrigin] = useState(window.location.origin);
  useEffect(() => {
    void fetch('/api/network').then((response) => response.ok ? response.json() as Promise<{ origin: string }> : Promise.reject(new Error('network endpoint unavailable'))).then((payload) => setLanOrigin(payload.origin)).catch(() => undefined);
  }, []);
  const displayUrl = `${lanOrigin}/display?session=${state.sessionId}`;
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="brand-mark"><ShieldCheck size={19} /></div>
        <div><div className="brand-name">合规台</div><div className="brand-sub">LIVE COMPLIANCE COPILOT</div></div>
      </div>
      <div className="live-chip"><span className={`signal-dot ${connected ? 'on' : ''}`} />{connected ? 'LIVE SESSION' : 'CONNECTING'}<span className="chip-divider" />{state.sessionId || '等待会话'}</div>
      <div className="top-actions">
        <div className="status-copy"><span className={`status-indicator ${connected ? 'ok' : 'muted'}`} />{status}</div>
        {mode === 'operator' && <a className="icon-button quiet" href={displayUrl} target="_blank" rel="noreferrer" title="打开主播屏"><Monitor size={17} /><span>主播屏</span><ExternalLink size={13} /></a>}
        {mode === 'display' && <a className="icon-button quiet" href={`/?session=${state.sessionId}`} title="打开控制台"><ArrowUpRight size={17} /><span>控制台</span></a>}
      </div>
    </header>
  );
}

function ProductRail({ state, send }: { state: SessionState; send: (message: object) => void }) {
  return (
    <section className="rail-section product-rail">
      <div className="section-kicker">当前商品 <span>PRODUCT QUEUE</span></div>
      <div className="product-list">
        {PRODUCTS.map((product) => <button type="button" className={`product-item ${state.product.id === product.id ? 'selected' : ''}`} key={product.id} onClick={() => send({ type: 'product.select', productId: product.id })}>
          <img src={product.image} alt="" /><span className="product-item-copy"><strong>{product.name}</strong><small>{product.category} · {product.price}</small></span><ChevronRight size={15} className="product-chevron" />
        </button>)}
      </div>
      <div className="product-now"><img src={state.product.image} alt="" /><div><span>ON AIR PRODUCT</span><strong>{state.product.name}</strong><small>{state.product.category} · {state.product.price}</small></div></div>
    </section>
  );
}

function MicPanel({ isListening, send }: { isListening: boolean; send: (message: object) => void }) {
  const microphone = useMicrophone(send, isListening);
  const [showDevices, setShowDevices] = useState(false);
  useEffect(() => { if (isListening) void microphone.start(); }, [isListening]);
  return <section className="rail-section mic-section">
    <div className="section-kicker">收音设备 <span>INPUT</span></div>
    <div className="mic-device-row"><div className={`mic-orb ${isListening ? 'active' : ''}`}><Mic size={21} /></div><div className="mic-device-name"><strong>{isListening ? '正在实时收音' : '蓝牙麦克风待机'}</strong><small>{microphone.devices.find((device) => device.deviceId === microphone.deviceId)?.label || '请先允许浏览器访问麦克风'}</small></div></div>
    <button type="button" className="device-toggle" onClick={() => { setShowDevices((value) => !value); void microphone.refresh(); }}><Headphones size={15} />选择输入设备 <ChevronRight size={14} className={showDevices ? 'rotate' : ''} /></button>
    {showDevices && <div className="device-select-wrap"><select value={microphone.deviceId} onChange={(event) => microphone.setDeviceId(event.target.value)} aria-label="选择麦克风"><option value="">系统默认输入</option>{microphone.devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `麦克风 ${device.deviceId.slice(0, 5)}`}</option>)}</select></div>}
    {microphone.error && <div className="inline-error"><AlertTriangle size={14} />{microphone.error}</div>}
    <div className="mic-control-row"><button type="button" className={`main-control ${isListening ? 'stop' : 'start'}`} onClick={() => send({ type: isListening ? 'control.stop' : 'control.start' })}>{isListening ? <><CircleStop size={16} />停止收音</> : <><Play size={16} fill="currentColor" />开始收音</>}</button><span className="capture-note"><span className={`capture-dot ${isListening ? 'active' : ''}`} />{isListening ? '16kHz PCM' : '未连接'}</span></div>
  </section>;
}

function Waveform({ active }: { active: boolean }) {
  return <div className={`waveform ${active ? 'active' : ''}`} aria-hidden="true">{Array.from({ length: 32 }, (_, index) => <i key={index} style={{ '--bar': `${16 + ((index * 13) % 24)}%`, '--delay': `${index * 35}ms` } as React.CSSProperties} />)}</div>;
}

function TranscriptStage({ state }: { state: SessionState }) {
  const lastFinal = state.transcriptHistory[state.transcriptHistory.length - 1];
  return <section className="stage-section transcript-stage">
    <div className="section-heading"><div><span className="section-kicker">实时转录 <span>VOLCENGINE ASR</span></span><h1>{state.partialTranscript || lastFinal?.text || '等待主播开口'}</h1></div><div className="asr-badge"><span className="signal-dot on" />{state.isListening ? 'STREAMING' : 'STANDBY'}</div></div>
    <Waveform active={state.isListening} />
    <div className="transcript-feed">{state.transcriptHistory.slice(-4).map((segment, index) => <div className={`feed-line ${index === state.transcriptHistory.slice(-4).length - 1 ? 'current' : ''}`} key={segment.id}><time><span>{new Date(segment.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><em>{formatReplayOffset(segment.offsetMs)}</em></time><span>{segment.text}</span></div>)}</div>
  </section>;
}

function PromptPanel({ state, compact = false }: { state: SessionState; compact?: boolean }) {
  const latest = state.latestCompliance;
  const phrase = latest && latest.risk !== 'safe' ? latest.alternative : state.product.compliantPhrases[0];
  return <section className={`prompt-panel ${latest?.risk ?? 'safe'} ${compact ? 'compact' : ''}`}>
    <div className="prompt-head"><div><span className="section-kicker">主播提词 <span>READY TO SAY</span></span><h2>{latest && latest.risk !== 'safe' ? '现在请替换为' : '当前商品建议表达'}</h2></div><Sparkles size={20} /></div>
    <p className="prompt-quote">{phrase}</p>
    <div className="prompt-foot"><span><Keyboard size={14} />建议照读</span><span className="prompt-product">{state.product.name}</span></div>
  </section>;
}

function CompliancePanel({ result }: { result: ComplianceResult | null }) {
  const resolved = result ?? { risk: 'safe' as const, title: '等待下一句', reason: '系统会在每个转录片段完成后即时分析。', policyRef: '豆包大模型 · 抖音直播规则', confidence: 0 };
  return <section className={`compliance-panel ${resolved.risk}`}>
    <div className="compliance-top"><div className="risk-pill"><RiskIcon risk={resolved.risk} /><span><RiskLabel risk={resolved.risk} /></span></div><span className="confidence">{resolved.confidence ? `${Math.round(resolved.confidence * 100)}% 置信` : '实时监测'}</span></div>
    <h3>{resolved.title}</h3><p>{resolved.reason}</p><div className="policy-ref"><ShieldCheck size={14} />{resolved.policyRef}</div>
  </section>;
}

function DemoInput({ send }: { send: (message: object) => void }) {
  const [text, setText] = useState('');
  const examples = [
    { label: '安全表达', text: '这款精华质地清爽，适合日常护肤，肤感因人而异。', tone: 'safe' },
    { label: '极限词', text: '今天是全网最低价，错过这一次就没有了！', tone: 'warning' },
    { label: '绝对承诺', text: '这款精华用了三天保证你脸上的斑全部消失！', tone: 'blocked' },
  ];
  return <section className="demo-bar"><div className="demo-label"><Radio size={15} />演示输入 <span>无密钥也可体验</span></div><div className="demo-actions">{examples.map((example) => <button type="button" className={`demo-chip ${example.tone}`} key={example.label} onClick={() => send({ type: 'demo.transcript', text: example.text })}>{example.label}</button>)}</div><form onSubmit={(event) => { event.preventDefault(); if (text.trim()) { send({ type: 'demo.transcript', text: text.trim() }); setText(''); } }} className="demo-form"><input value={text} onChange={(event) => setText(event.target.value)} placeholder="输入一句主播话术模拟分析" /><button type="submit" title="发送模拟话术"><ArrowUpRight size={16} /></button></form></section>;
}

function SessionStats({ state }: { state: SessionState }) {
  return <div className="session-stats"><div><span>已播时长</span><strong>{Math.floor(state.stats.speakingSeconds / 60).toString().padStart(2, '0')}:{(state.stats.speakingSeconds % 60).toString().padStart(2, '0')}</strong></div><div><span>识别字数</span><strong>{state.stats.words}</strong></div><div><span>高风险</span><strong className="danger-text">{state.stats.blockedCount}</strong></div><div><span>需留意</span><strong className="warning-text">{state.stats.warningCount}</strong></div></div>;
}

function OperatorScreen() {
  const session = useLiveSession('operator');
  return <div className="app-shell operator-shell"><AppHeader state={session.state} connected={session.connected} status={session.status} mode="operator" /><main className="operator-grid"><aside className="left-rail"><ProductRail state={session.state} send={session.send} /><MicPanel isListening={session.state.isListening} send={session.send} /><div className="rail-footer"><Wifi size={14} />局域网地址可供 iPad 访问</div></aside><section className="main-stage"><div className="stage-context"><div><span className="eyebrow">TODAY'S LIVE · 01</span><h2>{session.state.product.name}</h2></div><div className="context-actions"><span className="ai-tag"><ShieldCheck size={14} />豆包合规引擎</span><span className="context-dot" />火山实时语音</div></div><TranscriptStage state={session.state} /><DemoInput send={session.send} /></section><aside className="coach-rail"><PromptPanel state={session.state} /><CompliancePanel result={session.state.latestCompliance} /><section className="alert-history"><div className="section-kicker">近期提醒 <span>ALERT LOG</span></div>{session.state.alerts.length ? session.state.alerts.slice(0, 4).map((alert) => <div className="alert-row" key={alert.id}><div className={`alert-icon ${alert.risk}`}><RiskIcon risk={alert.risk} /></div><div><strong>{alert.title}</strong><small>{new Date(alert.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · {alert.alternative.replace(/^可以改为：/u, '')}</small></div></div>) : <div className="empty-alert"><Check size={16} />暂无风险提醒</div>}</section></aside></main><footer className="operator-footer"><SessionStats state={session.state} /><div className="footer-note"><Activity size={15} />风险判断以豆包大模型为主，未配置密钥时使用本地规则即时兜底</div></footer></div>;
}

function DisplayScreen() {
  const session = useLiveSession('display');
  const result = session.state.latestCompliance;
  const latestSegment = session.state.transcriptHistory.at(-1);
  const risk = result?.risk ?? 'safe';
  return <div className={`app-shell display-shell risk-${risk}`}><AppHeader state={session.state} connected={session.connected} status={session.status} mode="display" /><main className="display-main"><div className="display-product"><img src={session.state.product.image} alt="" /><div><span className="eyebrow">ON AIR PRODUCT · {session.state.product.category}</span><h1>{session.state.product.name}</h1><strong>{session.state.product.price}</strong></div><div className="display-live"><span className="signal-dot on" />{session.state.isListening ? '正在收音' : '等待收音'}</div></div><section className="display-voice"><div className="display-voice-label"><Volume2 size={17} />主播刚刚说 <span>{formatReplayOffset(latestSegment?.offsetMs ?? null)}</span></div><div className="display-transcript">{session.state.partialTranscript || latestSegment?.text || '等待下一句转录…'}</div><Waveform active={session.state.isListening} /></section><section className={`display-alert ${risk}`}><div className="display-alert-head"><div className="display-risk-icon"><RiskIcon risk={risk} /></div><div><span className="eyebrow">{result ? '即时合规提醒' : '合规提词就绪'}</span><h2>{result ? <RiskLabel risk={risk} /> : '可以继续介绍当前商品'}</h2></div><span className="display-source">{result?.source === 'doubao' ? 'DOUBAO' : 'LOCAL GUARDRAIL'}</span></div><div className="display-divider" /><div className="display-prompt-label">{result && result.risk !== 'safe' ? '请立即替换为' : '推荐表达'}</div><p className="display-prompt">{result && result.risk !== 'safe' ? result.alternative : session.state.product.compliantPhrases[0]}</p>{result && result.risk !== 'safe' && <p className="display-reason"><AlertTriangle size={15} />{result.reason}</p>}</section></main><footer className="display-footer"><div><ShieldCheck size={15} />抖音直播合规实时预警</div><div className="display-footer-stats"><span>监测 {session.state.stats.words} 字</span><span>高风险 {session.state.stats.blockedCount}</span><span>需留意 {session.state.stats.warningCount}</span></div></footer></div>;
}

export default function App() {
  return window.location.pathname.startsWith('/display') ? <DisplayScreen /> : <OperatorScreen />;
}
