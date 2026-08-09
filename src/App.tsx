import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  ClipboardPaste,
  Database,
  ChevronRight,
  CircleStop,
  FileAudio,
  ExternalLink,
  Headphones,
  Keyboard,
  LockKeyhole,
  LogOut,
  Mic,
  Monitor,
  Pencil,
  Pause,
  Plus,
  Play,
  QrCode,
  Copy,
  Radio,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Volume2,
  Wifi,
  UserRound,
  UsersRound,
  XCircle,
} from 'lucide-react';
import QRCode from 'qrcode';
import { DEFAULT_PRODUCT } from './shared/products';
import { complianceForLatestSegment, complianceForPrompt } from './compliance/currentCompliance';
import { canSelectInputDevice, switchInputDevice } from './microphoneDevice';
import type { ComplianceResult, ComplianceRule, CoachSuggestion, LiveRoom, Product, ProductImportResponse, PresenterPhrase, PresenterProfile, RuleAuditEntry, ServerMessage, SessionState, SessionTimelineExport, SpeakerLabel, SpeechCorrectionEntry, TimelineEvent, TranscriptSegment } from './shared/types';

type Role = 'operator' | 'display';
type AuthIdentity = { actorId: string; displayName: string; role: 'operator' | 'reviewer'; roomIds: string[] };
type OperatorAccess = AuthIdentity & { token: string; mode: 'multi-user' | 'local-only' };
type Readiness = {
  readyForLive: boolean;
  readyForProduction: boolean;
  mode: 'production' | 'live-with-local-persistence' | 'demo';
  streamingAsr: { configured: boolean; label: string };
  arkResponses: { configured: boolean; label: string };
  auth: { configured: boolean; label: string };
  storage: { configured: boolean; label: string };
  database: { configured: boolean; label: string };
  objectStorage: { configured: boolean; label: string; status?: { pending: number; failed: number } };
  redis: { configured: boolean; label: string };
  knowledge: { configured: boolean; available: boolean; label: string; detail: string; lastError?: string };
};

function storedActorId(): string {
  const stored = localStorage.getItem('live-actor');
  if (stored) return stored;
  const generated = `operator-${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem('live-actor', generated);
  return generated;
}

function accessHeaders(actorId: string, token = '', contentType = false): Record<string, string> {
  return {
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    'X-Actor-Id': actorId,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

const EMPTY_STATE: SessionState = {
  sessionId: '',
  roomId: 'room-default',
  presenterId: 'presenter-default',
  presenterName: '默认主播',
  product: DEFAULT_PRODUCT,
  lineup: [DEFAULT_PRODUCT],
  isListening: false,
  captureState: 'idle',
  partialTranscript: '',
  transcriptHistory: [],
  latestCompliance: null,
  riskProfile: 'balanced',
  productContextStartedAt: 0,
  alerts: [],
  stats: { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 },
  lastEventAt: Date.now(),
};

function useLiveSession(role: Role, access?: OperatorAccess) {
  const [state, setState] = useState<SessionState>(EMPTY_STATE);
  const [sessionId, setSessionId] = useState(() => new URLSearchParams(window.location.search).get('session') ?? localStorage.getItem('live-session') ?? '');
  const [roomId] = useState(() => new URLSearchParams(window.location.search).get('room') ?? localStorage.getItem('live-room') ?? 'room-default');
  const displayAlias = role === 'display' ? /^\/screen\/([A-Z0-9]{8})$/u.exec(window.location.pathname)?.[1] : undefined;
  const [localActorId] = useState(storedActorId);
  const actorId = access?.actorId ?? localActorId;
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('正在连接会话');
  const [captureDeniedVersion, setCaptureDeniedVersion] = useState(0);
  const [analysisStartedAt, setAnalysisStartedAt] = useState<number | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef(sessionId);
  const analysisSegmentRef = useRef<string | null>(null);

  useEffect(() => {
    let reconnectTimer: number | undefined;
    let disposed = false;
    const connect = () => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socketRef.current = socket;
      socket.onopen = () => {
        setConnected(true);
        socket.send(JSON.stringify({ type: 'session.join', sessionId: sessionIdRef.current || undefined, roomId, displayAlias, actorId, token: access?.token || undefined, role }));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === 'connection.ready') {
          sessionIdRef.current = message.sessionId;
          setSessionId(message.sessionId);
          localStorage.setItem('live-session', message.sessionId);
          setStatus('会话已连接');
        } else if (message.type === 'state.snapshot') {
          setState(message.state);
          if (message.state.latestCompliance?.segmentId === message.state.transcriptHistory.at(-1)?.id) {
            analysisSegmentRef.current = null;
            setAnalysisStartedAt(null);
          }
        } else if (message.type === 'transcript.partial') {
          setState((current) => ({ ...current, partialTranscript: message.segment.text }));
        } else if (message.type === 'transcript.final') {
          analysisSegmentRef.current = message.segment.id;
          setAnalysisStartedAt(Date.now());
          setState((current) => {
            const existingIndex = current.transcriptHistory.findIndex((segment) => segment.id === message.segment.id);
            const transcriptHistory = existingIndex < 0
              ? [...current.transcriptHistory, message.segment].slice(-20)
              : current.transcriptHistory.map((segment, index) => index === existingIndex ? message.segment : segment);
            return { ...current, partialTranscript: '', transcriptHistory };
          });
        } else if (message.type === 'compliance.result') {
          if (analysisSegmentRef.current === message.result.segmentId) {
            analysisSegmentRef.current = null;
            setAnalysisStartedAt(null);
          }
        } else if (message.type === 'system.status') {
          setStatus(message.message);
        } else if (message.type === 'capture.denied') {
          setCaptureDeniedVersion((current) => current + 1);
          setStatus(message.message);
        } else if (message.type === 'system.error') {
          setStatus(message.message);
        }
      };
      socket.onclose = () => {
        setConnected(false);
        analysisSegmentRef.current = null;
        setAnalysisStartedAt(null);
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
  }, [access?.token, actorId, displayAlias, role, roomId]);

  const send = useCallback((message: object) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return false;
    socketRef.current.send(JSON.stringify(message));
    return true;
  }, []);

  return { state, sessionId, roomId, actorId, connected, status, captureDeniedVersion, analysisStartedAt, send };
}

function useOperatorAccess() {
  const [localActorId] = useState(storedActorId);
  const [access, setAccess] = useState<OperatorAccess | null>(null);
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    let disposed = false;
    const token = localStorage.getItem('live-auth-token') ?? '';
    const refreshReadiness = async () => {
      const response = await fetch('/api/readiness');
      if (!response.ok) throw new Error('开播检查暂时不可用');
      const ready = await response.json() as Readiness;
      if (!disposed) setReadiness(ready);
    };
    void Promise.all([fetch('/api/auth/status', { headers: accessHeaders(localActorId, token) }), fetch('/api/readiness')]).then(async ([authResponse, readinessResponse]) => {
      const auth = await authResponse.json() as { mode: OperatorAccess['mode']; authenticated: boolean; identity?: AuthIdentity; message?: string };
      const ready = await readinessResponse.json() as Readiness;
      if (disposed) return;
      setReadiness(ready);
      if (auth.authenticated && auth.identity) setAccess({ ...auth.identity, token, mode: auth.mode });
      else {
        localStorage.removeItem('live-auth-token');
        setMessage(auth.message ?? '请登录控制台');
      }
    }).catch((error: unknown) => { if (!disposed) setMessage(error instanceof Error ? error.message : String(error)); }).finally(() => { if (!disposed) setLoading(false); });
    const readinessTimer = window.setInterval(() => { void refreshReadiness().catch(() => undefined); }, 5_000);
    return () => {
      disposed = true;
      window.clearInterval(readinessTimer);
    };
  }, [localActorId]);

  const login = async (actorId: string, password: string) => {
    setMessage('');
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actorId, password }) });
      const body = await response.json() as { identity?: AuthIdentity; token?: string; message?: string };
      if (!response.ok || !body.identity || !body.token) return setMessage(body.message ?? '登录失败');
      localStorage.setItem('live-auth-token', body.token);
      localStorage.setItem('live-actor', body.identity.actorId);
      setAccess({ ...body.identity, token: body.token, mode: 'multi-user' });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const logout = () => {
    localStorage.removeItem('live-auth-token');
    setAccess(null);
    setMessage('已退出登录');
  };

  return { access, readiness, loading, message, login, logout };
}

function useMicrophone(send: (message: object) => void, streamingEnabled: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [error, setError] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [level, setLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const requestVersionRef = useRef(0);
  const deviceIdRef = useRef('');
  const streamingRef = useRef(streamingEnabled);
  const lastLevelUpdateRef = useRef(0);

  useEffect(() => { streamingRef.current = streamingEnabled; }, [streamingEnabled]);

  const refresh = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const list = await navigator.mediaDevices.enumerateDevices();
    const inputs = list.filter((device) => device.kind === 'audioinput');
    setDevices(inputs);
    const selectedStillExists = deviceIdRef.current && inputs.some((input) => input.deviceId === deviceIdRef.current);
    if ((!deviceIdRef.current || !selectedStillExists) && inputs[0]) {
      deviceIdRef.current = inputs[0].deviceId;
      setDeviceId(inputs[0].deviceId);
    }
  }, []);

  useEffect(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  }, [refresh]);

  const stop = useCallback(() => {
    requestVersionRef.current += 1;
    processorRef.current?.disconnect();
    processorRef.current = null;
    contextRef.current?.close();
    contextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCapturing(false);
    setLevel(0);
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(async (requestedDeviceId = deviceIdRef.current) => {
    if (streamRef.current) return true;
    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    try {
      setError('');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: requestedDeviceId ? { exact: requestedDeviceId } : undefined, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (requestVersionRef.current !== requestVersion) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }
      streamRef.current = stream;
      const context = new AudioContext();
      contextRef.current = context;
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        let energy = 0;
        for (const sample of input) energy += sample * sample;
        const now = performance.now();
        if (now - lastLevelUpdateRef.current >= 80) {
          const rms = Math.sqrt(energy / Math.max(1, input.length));
          setLevel(Math.min(100, Math.round(rms * 360)));
          lastLevelUpdateRef.current = now;
        }
        if (!streamingRef.current) return;
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
      setCapturing(true);
      void refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法访问麦克风');
      return false;
    }
  }, [refresh, send]);

  const selectDevice = useCallback(async (nextDeviceId: string) => {
    if (deviceIdRef.current === nextDeviceId) return true;
    deviceIdRef.current = nextDeviceId;
    setDeviceId(nextDeviceId);
    return switchInputDevice(nextDeviceId, { capturing: Boolean(streamRef.current), stop, start });
  }, [start, stop]);

  return { devices, deviceId, selectDevice, start, stop, capturing, level, error, refresh };
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

function formatTranscriptOffset(offsetMs: number | null): string {
  return offsetMs === null ? '演示话术' : formatReplayOffset(offsetMs);
}

type DisplayLinkResponse = { alias: string; displayUrl: string; expiresAt: number; expiresInSeconds: number };

function AppHeader({ state, connected, status, mode, access }: { state: SessionState; connected: boolean; status: string; mode: Role; access?: OperatorAccess }) {
  const [displayLink, setDisplayLink] = useState<DisplayLinkResponse | null>(null);
  const [qrCode, setQrCode] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [shareError, setShareError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (mode !== 'operator' || !state.sessionId || !access) {
      setDisplayLink(null);
      setQrCode('');
      return;
    }
    let disposed = false;
    setShareError('');
    void fetch(`/api/session/${encodeURIComponent(state.sessionId)}/display-link`, { method: 'POST', headers: accessHeaders(access.actorId, access.token) })
      .then(async (response) => {
        const payload = await response.json() as DisplayLinkResponse & { message?: string };
        if (!response.ok) throw new Error(payload.message ?? '主播屏入口生成失败');
        return payload;
      })
      .then((payload) => { if (!disposed) setDisplayLink(payload); })
      .catch((error: unknown) => { if (!disposed) setShareError(error instanceof Error ? error.message : '主播屏入口生成失败'); });
    return () => { disposed = true; };
  }, [access?.actorId, access?.token, mode, state.sessionId]);
  useEffect(() => {
    if (!displayLink) return;
    let disposed = false;
    void QRCode.toDataURL(displayLink.displayUrl, { width: 240, margin: 2, errorCorrectionLevel: 'M' })
      .then((dataUrl) => { if (!disposed) setQrCode(dataUrl); })
      .catch(() => { if (!disposed) setQrCode(''); });
    return () => { disposed = true; };
  }, [displayLink]);
  const copyDisplayUrl = async () => {
    if (!displayLink || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(displayLink.displayUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch { setCopied(false); }
  };
  return (
    <header className="topbar">
      <div className="brand-lockup">
        <div className="brand-mark"><ShieldCheck size={19} /></div>
        <div><div className="brand-name">dypro</div><div className="brand-sub">抖音直播合规预警</div></div>
      </div>
      <div className="live-chip"><span className={`signal-dot ${connected ? 'on' : ''}`} />{connected ? 'LIVE SESSION' : 'CONNECTING'}<span className="chip-divider" />{state.sessionId || '等待会话'}</div>
      <div className="top-actions">
        <div className="status-copy"><span className={`status-indicator ${connected ? 'ok' : 'muted'}`} />{status}</div>
        {mode === 'operator' && <>
          {displayLink ? <a className="icon-button quiet" href={displayLink.displayUrl} target="_blank" rel="noreferrer" title="打开主播屏"><Monitor size={17} /><span>主播屏</span><ExternalLink size={13} /></a> : <button type="button" className="icon-button quiet" disabled title="正在生成主播屏入口"><Monitor size={17} /><span>主播屏</span></button>}
          <div className="display-share">
            <button type="button" className="icon-button quiet display-share-trigger" disabled={!displayLink} onClick={() => setShareOpen((open) => !open)} title="查看主播屏二维码"><QrCode size={17} /><span>{displayLink ? `扫码 · ${displayLink.alias}` : '主播屏二维码'}</span></button>
            {shareOpen && displayLink && <section className="display-share-panel" aria-label="主播屏入口">
              <div className="display-share-head"><div><strong>主播屏入口</strong><small>临时地址 · {new Date(displayLink.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 失效</small></div><button type="button" className="icon-button quiet" onClick={() => setShareOpen(false)} title="关闭二维码">×</button></div>
              {qrCode ? <img className="display-share-qr" src={qrCode} alt={`主播屏二维码 ${displayLink.alias}`} /> : <div className="display-share-qr-loading">正在生成二维码</div>}
              <div className="display-share-code"><span>短地址名称</span><strong>{displayLink.alias}</strong></div>
              <div className="display-share-actions"><a href={displayLink.displayUrl} target="_blank" rel="noreferrer"><Monitor size={14} />打开主播屏</a><button type="button" onClick={() => void copyDisplayUrl()} disabled={!navigator.clipboard} title="复制主播屏地址">{copied ? <Check size={14} /> : <Copy size={14} />}</button></div>
              {shareError && <small className="display-share-error">{shareError}</small>}
            </section>}
          </div>
        </>}
        {mode === 'display' && <a className="icon-button quiet" href={`/?session=${state.sessionId}&room=${state.roomId}`} title="打开控制台"><ArrowUpRight size={17} /><span>控制台</span></a>}
      </div>
    </header>
  );
}

function ProductRail({ state, send, onOpenLibrary }: { state: SessionState; send: (message: object) => void; onOpenLibrary: () => void }) {
  return (
    <section className="rail-section product-rail">
      <div className="section-kicker">当前商品 <span>PRODUCT QUEUE</span></div>
      <div className="product-list">
        {state.lineup.map((product) => <button type="button" className={`product-item ${state.product.id === product.id ? 'selected' : ''}`} key={product.id} onClick={() => send({ type: 'product.select', productId: product.id })}>
          <img src={product.image} alt="" /><span className="product-item-copy"><strong>{product.name}</strong><small>{product.category} · {product.price}</small></span><ChevronRight size={15} className="product-chevron" />
        </button>)}
      </div>
      <button type="button" className="library-button" onClick={onOpenLibrary}><ClipboardPaste size={14} />管理商品库与本场清单</button>
    </section>
  );
}

type RuleDraft = Pick<ComplianceRule, 'name' | 'scope' | 'matchType' | 'pattern' | 'risk' | 'title' | 'reason' | 'alternative' | 'policyRef'>;

const EMPTY_RULE: RuleDraft = {
  name: '', scope: 'room', matchType: 'contains', pattern: '', risk: 'warning', title: '', reason: '', alternative: '', policyRef: '内部收集规则',
};

const RULE_STATUS_LABEL: Record<ComplianceRule['status'], string> = {
  draft: '草稿', pending_review: '待审核', published: '已生效', rejected: '已驳回', rolled_back: '已回滚',
};
const RULE_ACTION_LABEL: Record<RuleAuditEntry['action'], string> = {
  created: '创建', learned: '智能发现', observed: '新增证据', submitted: '提交审核', approved: '审核通过', rejected: '驳回', edited: '保存新版本', rolled_back: '回滚', disabled: '停用', enabled: '启用',
};

function WorkspaceModal({ state, access, send, onClose, onLogout }: { state: SessionState; access: OperatorAccess; send: (message: object) => boolean; onClose: () => void; onLogout: () => void }) {
  const actorId = access.actorId;
  const [tab, setTab] = useState<'products' | 'rules' | 'phrases'>('products');
  const [rooms, setRooms] = useState<LiveRoom[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>(state.lineup.map((product) => product.id));
  const [importText, setImportText] = useState('');
  const [importResult, setImportResult] = useState<ProductImportResponse | null>(null);
  const [rules, setRules] = useState<ComplianceRule[]>([]);
  const [audits, setAudits] = useState<RuleAuditEntry[]>([]);
  const [ruleDraft, setRuleDraft] = useState<RuleDraft>(EMPTY_RULE);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [newRoomName, setNewRoomName] = useState('');
  const [newAccountName, setNewAccountName] = useState('');
  const [actorDraft, setActorDraft] = useState(actorId);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const actorHeaders = accessHeaders(actorId, access.token, true);
  const refresh = useCallback(async () => {
    const [roomsResponse, productsResponse, rulesResponse, auditsResponse] = await Promise.all([
      fetch('/api/rooms', { headers: actorHeaders }), fetch(`/api/rooms/${state.roomId}/products`, { headers: actorHeaders }), fetch(`/api/rooms/${state.roomId}/rules`, { headers: actorHeaders }), fetch(`/api/rooms/${state.roomId}/rules/audits`, { headers: actorHeaders }),
    ]);
    if (!roomsResponse.ok || !productsResponse.ok || !rulesResponse.ok || !auditsResponse.ok) throw new Error('工作区数据读取失败');
    setRooms(await roomsResponse.json() as LiveRoom[]);
    setProducts(await productsResponse.json() as Product[]);
    setRules(await rulesResponse.json() as ComplianceRule[]);
    setAudits(await auditsResponse.json() as RuleAuditEntry[]);
  }, [access.token, actorId, state.roomId]);

  useEffect(() => { void refresh().catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error))); }, [refresh]);

  const switchRoom = (roomId: string) => {
    localStorage.setItem('live-room', roomId);
    localStorage.removeItem('live-session');
    window.location.assign(`/?room=${roomId}`);
  };

  const switchActor = () => {
    const nextActor = actorDraft.trim();
    if (!nextActor) return;
    localStorage.setItem('live-actor', nextActor);
    window.location.reload();
  };

  const parseProduct = async () => {
    if (!importText.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch('/api/products/parse', { method: 'POST', headers: actorHeaders, body: JSON.stringify({ text: importText }) });
      const body = await response.json() as ProductImportResponse & { message?: string };
      if (!response.ok) throw new Error(body.message ?? '商品识别失败');
      setImportResult(body);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const saveProduct = async () => {
    if (!importResult) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/rooms/${state.roomId}/products`, { method: 'POST', headers: actorHeaders, body: JSON.stringify({ product: importResult.product }) });
      const saved = await response.json() as Product & { message?: string };
      if (!response.ok) throw new Error(saved.message ?? '商品保存失败');
      setSelectedIds((current) => [...new Set([...current, saved.id])]);
      setImportText('');
      setImportResult(null);
      await refresh();
      setMessage('商品已保存到当前直播间');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const createRoom = async () => {
    if (!newRoomName.trim() || !newAccountName.trim()) return;
    const response = await fetch('/api/rooms', { method: 'POST', headers: actorHeaders, body: JSON.stringify({ name: newRoomName, accountName: newAccountName }) });
    const body = await response.json() as LiveRoom & { message?: string };
    if (!response.ok) return setMessage(body.message ?? '直播间创建失败');
    switchRoom(body.id);
  };

  const saveRule = async () => {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(editingRuleId ? `/api/rules/${editingRuleId}` : `/api/rooms/${state.roomId}/rules`, { method: editingRuleId ? 'PATCH' : 'POST', headers: actorHeaders, body: JSON.stringify(ruleDraft) });
      const body = await response.json() as ComplianceRule & { message?: string };
      if (!response.ok) throw new Error(body.message ?? '规则保存失败');
      setRuleDraft(EMPTY_RULE);
      setEditingRuleId(null);
      await refresh();
      setMessage(body.status === 'pending_review' ? '共享规则已提交审核' : '规则已立即生效');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const ruleAction = async (rule: ComplianceRule, action: 'approve' | 'reject' | 'rollback') => {
    setBusy(true);
    setMessage('');
    try {
      const body = action === 'rollback' ? { targetVersion: Math.max(1, rule.version - 1) } : {};
      const response = await fetch(`/api/rules/${rule.id}/${action}`, { method: 'POST', headers: actorHeaders, body: JSON.stringify(body) });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message ?? '规则操作失败');
      await refresh();
      setMessage('规则状态已更新');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const currentRoom = rooms.find((room) => room.id === state.roomId);
  const canManageRule = (rule: ComplianceRule) => access.role === 'reviewer' || rule.createdBy === actorId || (rule.scope === 'room' && currentRoom?.ownerActorId === actorId);
  const setRuleEnabled = async (rule: ComplianceRule) => {
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/rules/${rule.id}/enabled`, { method: 'POST', headers: actorHeaders, body: JSON.stringify({ enabled: !rule.enabled }) });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message ?? '规则启停失败');
      await refresh();
      setMessage(rule.enabled ? '规则已停用' : '规则已重新启用');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return <div className="modal-backdrop" role="presentation"><section className="workspace-modal" role="dialog" aria-modal="true" aria-label="直播间工作区">
    <header className="workspace-head"><div><span className="section-kicker">直播间工作区 <span>ROOM DATA</span></span><h2>{currentRoom?.name ?? '当前直播间'}</h2><p>{currentRoom?.accountName ?? state.roomId} · 负责人 {currentRoom?.ownerActorId ?? 'owner'}</p></div>{access.mode === 'multi-user' ? <div className="actor-identity"><span><LockKeyhole size={13} />{access.displayName}</span><small>{access.role === 'reviewer' ? '规则审核人' : '场控账号'}</small><button type="button" onClick={onLogout} title="退出登录"><LogOut size={14} /></button></div> : <div className="actor-switch"><input value={actorDraft} onChange={(event) => setActorDraft(event.target.value)} aria-label="当前操作人账号" /><button type="button" onClick={switchActor}>切换操作人</button></div>}<button type="button" className="modal-close" onClick={onClose} title="关闭">×</button></header>
    <div className="room-toolbar"><select value={state.roomId} onChange={(event) => switchRoom(event.target.value)} aria-label="切换直播间">{rooms.map((room) => <option key={room.id} value={room.id}>{room.name} · {room.accountName}</option>)}</select><input value={newRoomName} onChange={(event) => setNewRoomName(event.target.value)} placeholder="新直播间名称" /><input value={newAccountName} onChange={(event) => setNewAccountName(event.target.value)} placeholder="抖音账号名称" /><button type="button" onClick={() => void createRoom()}><Plus size={14} />创建</button></div>
    <div className="workspace-tabs"><button type="button" className={tab === 'products' ? 'active' : ''} onClick={() => setTab('products')}><Database size={15} />商品库</button><button type="button" className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}><ShieldCheck size={15} />规则库</button><button type="button" className={tab === 'phrases' ? 'active' : ''} onClick={() => setTab('phrases')}><Sparkles size={15} />主播话术库</button></div>
    {tab === 'products' ? <div className="workspace-grid">
      <section className="catalog-pane"><div className="pane-head"><div><strong>长期商品库</strong><span>{products.length} 件</span></div><button type="button" title="刷新" onClick={() => void refresh()}><RefreshCw size={14} /></button></div><div className="catalog-list">{products.map((product) => <label className="catalog-row" key={product.id}><input type="checkbox" checked={selectedIds.includes(product.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...new Set([...current, product.id])] : current.filter((id) => id !== product.id))} /><img src={product.image} alt="" /><span><strong>{product.name}</strong><small>{product.price} · 库存 {product.stock ?? '待确认'} · {product.sku || '无 SKU'}</small></span></label>)}</div><button type="button" className="primary-wide" disabled={selectedIds.length === 0} onClick={() => { if (send({ type: 'lineup.set', productIds: selectedIds })) onClose(); else setMessage('会话连接中，请稍后重试'); }}><Save size={15} />保存为本场商品清单</button></section>
      <section className="import-pane"><div className="pane-head"><div><strong>粘贴识别商品</strong><span>豆包结构化</span></div></div><textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴商品标题、详情、价格、库存、SKU、卖点等文本" /><button type="button" className="secondary-wide" disabled={busy || !importText.trim()} onClick={() => void parseProduct()}><ClipboardPaste size={15} />{busy ? '识别中' : '识别商品信息'}</button>{importResult && <div className="product-draft"><div className="draft-source">{importResult.source === 'doubao' ? 'DOUBAO' : 'LOCAL'} · {Math.round(importResult.confidence * 100)}%</div><label>名称<input value={importResult.product.name} onChange={(event) => setImportResult({ ...importResult, product: { ...importResult.product, name: event.target.value } })} /></label><div className="draft-fields"><label>价格<input value={importResult.product.price} onChange={(event) => setImportResult({ ...importResult, product: { ...importResult.product, price: event.target.value } })} /></label><label>库存<input type="number" value={importResult.product.stock ?? ''} onChange={(event) => setImportResult({ ...importResult, product: { ...importResult.product, stock: event.target.value ? Number(event.target.value) : null } })} /></label></div><label>SKU<input value={importResult.product.sku} onChange={(event) => setImportResult({ ...importResult, product: { ...importResult.product, sku: event.target.value } })} /></label>{importResult.warnings.map((warning) => <p key={warning}>{warning}</p>)}<button type="button" className="primary-wide" onClick={() => void saveProduct()}><Save size={15} />保存到商品库</button></div>}</section>
    </div> : tab === 'rules' ? <div className="workspace-grid rules-grid">
      <section className="rule-form"><div className="pane-head"><div><strong>{editingRuleId ? '编辑规则新版本' : '新增内部规则'}</strong><span>房间规则立即生效，共享规则需审核</span></div></div><input value={ruleDraft.name} onChange={(event) => setRuleDraft({ ...ruleDraft, name: event.target.value })} placeholder="规则名称" /><div className="draft-fields"><select value={ruleDraft.scope} onChange={(event) => setRuleDraft({ ...ruleDraft, scope: event.target.value as RuleDraft['scope'] })}><option value="room">当前直播间</option><option value="shared">共享规则</option></select><select value={ruleDraft.risk} onChange={(event) => setRuleDraft({ ...ruleDraft, risk: event.target.value as RuleDraft['risk'] })}><option value="warning">需留意</option><option value="blocked">高风险</option><option value="safe">安全提示（不覆盖高风险）</option></select></div><div className="draft-fields"><select value={ruleDraft.matchType} onChange={(event) => setRuleDraft({ ...ruleDraft, matchType: event.target.value as RuleDraft['matchType'] })}><option value="contains">包含关键词</option><option value="regex">正则表达式</option></select><input value={ruleDraft.pattern} onChange={(event) => setRuleDraft({ ...ruleDraft, pattern: event.target.value })} placeholder="违规词或匹配表达式" /></div><input value={ruleDraft.title} onChange={(event) => setRuleDraft({ ...ruleDraft, title: event.target.value })} placeholder="预警标题" /><textarea value={ruleDraft.reason} onChange={(event) => setRuleDraft({ ...ruleDraft, reason: event.target.value })} placeholder="违规原因" /><textarea value={ruleDraft.alternative} onChange={(event) => setRuleDraft({ ...ruleDraft, alternative: event.target.value })} placeholder="主播可立即照读的替代表达" /><button type="button" className="primary-wide" disabled={busy || !ruleDraft.name.trim() || !ruleDraft.pattern.trim() || !ruleDraft.title.trim() || !ruleDraft.reason.trim() || !ruleDraft.alternative.trim()} onClick={() => void saveRule()}><Save size={15} />{editingRuleId ? '保存新版本' : '保存规则'}</button></section>
      <section className="catalog-pane"><div className="pane-head"><div><strong>规则与审核</strong><span>{rules.length} 条 · 日志 {audits.length} 条</span></div><button type="button" title="刷新" onClick={() => void refresh()}><RefreshCw size={14} /></button></div><div className="rule-list">{rules.map((rule) => <div className="rule-row" key={rule.id}><div><span className={`rule-status ${rule.status} ${rule.enabled ? '' : 'disabled'}`}>{rule.enabled ? RULE_STATUS_LABEL[rule.status] : '已停用'}</span><strong>{rule.name}</strong><small>v{rule.version} · {rule.scope === 'shared' ? '共享' : '当前直播间'} · {rule.pattern}{rule.origin === 'learned' ? ` · 智能沉淀 ${Math.round((rule.confidence ?? 0) * 100)}% · 命中 ${rule.evidenceCount ?? 1} 次${(rule.evidenceRoomIds?.length ?? 1) > 1 ? ` · ${rule.evidenceRoomIds?.length} 个直播间` : ''}` : ''}</small></div><p>{rule.reason}</p><div className="rule-actions"><button type="button" disabled={busy} onClick={() => { setEditingRuleId(rule.id); setRuleDraft({ name: rule.name, scope: rule.scope, matchType: rule.matchType, pattern: rule.pattern, risk: rule.risk, title: rule.title, reason: rule.reason, alternative: rule.alternative, policyRef: rule.policyRef }); }}>编辑</button>{(access.role === 'reviewer' || (rule.scope === 'room' && currentRoom?.ownerActorId === actorId)) && rule.status === 'pending_review' && <><button type="button" disabled={busy} onClick={() => void ruleAction(rule, 'approve')}>审核通过</button><button type="button" disabled={busy} onClick={() => void ruleAction(rule, 'reject')}>驳回</button></>}{rule.version > 1 && canManageRule(rule) && <button type="button" disabled={busy} onClick={() => void ruleAction(rule, 'rollback')}>回滚上一版</button>}{canManageRule(rule) && rule.status === 'published' && <button type="button" disabled={busy} onClick={() => void setRuleEnabled(rule)}>{rule.enabled ? '停用' : '重新启用'}</button>}</div></div>)}</div><div className="audit-list"><strong>最近操作日志</strong>{audits.slice(-6).reverse().map((audit) => <div key={audit.id}><span>{new Date(audit.occurredAt).toLocaleString('zh-CN', { hour12: false })}</span><em>{audit.actorId}</em><span>{RULE_ACTION_LABEL[audit.action]}</span></div>)}</div></section>
    </div> : <PresenterPhrasePanel state={state} access={access} send={send} />}
    {message && <div className="workspace-message">{message}</div>}
  </section></div>;
}

function MicPanel({ state, connected, captureDeniedVersion, send, onOpenReview }: { state: SessionState; connected: boolean; captureDeniedVersion: number; send: (message: object) => boolean; onOpenReview: () => void }) {
  const microphone = useMicrophone(send, state.captureState === 'live' && state.isListening);
  const [showDevices, setShowDevices] = useState(false);
  const selected = microphone.devices.find((device) => device.deviceId === microphone.deviceId);
  const canSelectDevice = canSelectInputDevice(state.captureState, connected);
  useEffect(() => { if (captureDeniedVersion > 0) microphone.stop(); }, [captureDeniedVersion, microphone.stop]);
  useEffect(() => { if (!connected) microphone.stop(); }, [connected, microphone.stop]);
  useEffect(() => { if (state.captureState === 'ended') microphone.stop(); }, [microphone.stop, state.captureState]);

  const startLive = async (resume = false) => {
    if (!await microphone.start()) return;
    if (!send({ type: resume ? 'control.resume' : 'control.start' })) microphone.stop();
  };
  const endLive = () => {
    if (send({ type: 'control.end' })) microphone.stop();
  };
  const pauseLive = () => {
    if (send({ type: 'control.pause' })) microphone.stop();
  };
  const deviceTitle = state.captureState === 'ended' ? '本场直播已结束'
    : state.captureState === 'paused' ? '直播收音已暂停'
      : state.captureState === 'live' ? microphone.capturing ? '直播收音运行中' : '其他控制台正在收音'
        : microphone.capturing ? '正在测试输入音量' : '蓝牙麦克风待检测';
  const levelLabel = microphone.level >= 18 ? '音量正常' : microphone.level >= 5 ? '声音偏低' : '等待声音';
  return <section className="rail-section mic-section">
    <div className="section-kicker">直播收音 <span>{state.captureState.toUpperCase()}</span></div>
    <div className="mic-device-row"><div className={`mic-orb ${microphone.capturing ? 'active' : ''}`}><Mic size={21} /></div><div className="mic-device-name"><strong>{deviceTitle}</strong><small>{selected?.label || '尚未取得麦克风设备名称'}</small></div></div>
    <button type="button" className="device-toggle" disabled={!canSelectDevice} onClick={() => { setShowDevices((value) => !value); void microphone.refresh(); }}><Headphones size={15} />选择输入设备 <ChevronRight size={14} className={showDevices ? 'rotate' : ''} /></button>
    {showDevices && <div className="device-select-wrap"><select value={microphone.deviceId} onChange={(event) => { void microphone.selectDevice(event.target.value); }} aria-label="选择麦克风" disabled={!canSelectDevice}><option value="">系统默认输入</option>{microphone.devices.map((device) => <option key={device.deviceId} value={device.deviceId}>{device.label || `麦克风 ${device.deviceId.slice(0, 5)}`}</option>)}</select></div>}
    {microphone.error && <div className="inline-error"><AlertTriangle size={14} />{microphone.error}</div>}
    {microphone.capturing && <div className="mic-meter"><div className="mic-meter-track"><i style={{ width: `${Math.max(2, microphone.level)}%` }} /></div><span>{levelLabel}</span></div>}
    {state.captureState === 'idle' && <div className="mic-control-stack"><button type="button" className="test-control" onClick={() => microphone.capturing ? microphone.stop() : void microphone.start()} disabled={!connected}><Activity size={15} />{microphone.capturing ? '结束设备测试' : '检测并测试麦克风'}</button><button type="button" className="main-control start" onClick={() => void startLive()} disabled={!connected}><Radio size={16} />开始直播收音</button></div>}
    {state.captureState === 'live' && <div className="mic-control-stack horizontal"><button type="button" className="test-control" onClick={pauseLive} disabled={!connected}><Pause size={15} fill="currentColor" />暂停</button><button type="button" className="main-control stop" onClick={endLive} disabled={!connected}><CircleStop size={16} />结束直播</button></div>}
    {state.captureState === 'paused' && <div className="mic-control-stack horizontal"><button type="button" className="main-control start" onClick={() => void startLive(true)} disabled={!connected}><Play size={16} fill="currentColor" />继续收音</button><button type="button" className="main-control stop" onClick={endLive} disabled={!connected}><CircleStop size={16} />结束直播</button></div>}
    {state.captureState === 'ended' && <button type="button" className="review-control" onClick={onOpenReview}><FileAudio size={16} />复核音频与转录</button>}
    <span className="capture-note"><span className={`capture-dot ${state.isListening ? 'active' : ''}`} />{state.captureState === 'live' ? '流式语音识别中' : state.captureState === 'paused' ? '流式语音识别已暂停' : state.captureState === 'ended' ? '本地已归档' : microphone.capturing ? '本地设备测试' : '流式语音识别待命'}</span>
  </section>;
}

type ReviewTranscript = TranscriptSegment & {
  audioStartMs: number | null;
  audioEndMs: number | null;
  revisions: number;
  compliance?: Pick<ComplianceResult, 'risk' | 'matchedTerms'>;
};

function buildReviewTranscripts(events: TimelineEvent[]): ReviewTranscript[] {
  const transcripts = new Map<string, ReviewTranscript>();
  for (const event of events) {
    if (event.type === 'transcript.final') {
      const segmentId = typeof event.payload.segmentId === 'string' ? event.payload.segmentId : '';
      const text = typeof event.payload.text === 'string' ? event.payload.text : '';
      if (!segmentId || !text) continue;
      const audioStartSample = typeof event.payload.audioStartSample === 'number' ? event.payload.audioStartSample : null;
      const audioEndSample = typeof event.payload.audioEndSample === 'number' ? event.payload.audioEndSample : null;
      transcripts.set(segmentId, {
        id: segmentId,
        text,
        isFinal: true,
        timestamp: event.occurredAt,
        offsetMs: event.offsetMs,
        startOffsetMs: typeof event.payload.startOffsetMs === 'number' ? event.payload.startOffsetMs : null,
        endOffsetMs: typeof event.payload.endOffsetMs === 'number' ? event.payload.endOffsetMs : event.offsetMs,
        speaker: event.payload.speaker === 'other' ? 'other' : 'host',
        audioStartMs: audioStartSample === null ? null : Math.round((audioStartSample / 16_000) * 1_000),
        audioEndMs: audioEndSample === null ? null : Math.round((audioEndSample / 16_000) * 1_000),
        revisions: 0,
      });
    }
    if (event.type === 'transcript.corrected') {
      const segmentId = typeof event.payload.segmentId === 'string' ? event.payload.segmentId : '';
      const correctedText = typeof event.payload.correctedText === 'string' ? event.payload.correctedText : '';
      const existing = transcripts.get(segmentId);
      if (existing && correctedText) transcripts.set(segmentId, { ...existing, text: correctedText, compliance: undefined, revisions: existing.revisions + 1 });
    }
    if (event.type === 'transcript.annotated') {
      const segmentId = typeof event.payload.segmentId === 'string' ? event.payload.segmentId : '';
      const existing = transcripts.get(segmentId);
      if (existing) transcripts.set(segmentId, { ...existing, speaker: event.payload.speaker === 'other' ? 'other' : 'host' });
    }
    if (event.type === 'compliance.result') {
      const segmentId = typeof event.payload.transcriptSegmentId === 'string' ? event.payload.transcriptSegmentId : '';
      const existing = transcripts.get(segmentId);
      if (existing) transcripts.set(segmentId, {
        ...existing,
        compliance: {
          risk: event.payload.risk === 'blocked' || event.payload.risk === 'warning' ? event.payload.risk : 'safe',
          matchedTerms: Array.isArray(event.payload.matchedTerms) ? event.payload.matchedTerms.filter((term): term is string => typeof term === 'string') : [],
        },
      });
    }
  }
  return [...transcripts.values()].sort((first, second) => first.timestamp - second.timestamp);
}

function deriveTextDifference(originalText: string, correctedText: string): { wrongText: string; correctText: string } | null {
  const original = [...originalText];
  const corrected = [...correctedText];
  let prefix = 0;
  while (prefix < original.length && prefix < corrected.length && original[prefix] === corrected[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < original.length - prefix && suffix < corrected.length - prefix && original[original.length - 1 - suffix] === corrected[corrected.length - 1 - suffix]) suffix += 1;
  const wrongText = original.slice(prefix, original.length - suffix).join('').trim();
  const correctText = corrected.slice(prefix, corrected.length - suffix).join('').trim();
  return wrongText && correctText && wrongText !== correctText ? { wrongText, correctText } : null;
}

function SessionReviewModal({ state, access, onClose }: { state: SessionState; access: OperatorAccess; onClose: () => void }) {
  const [timeline, setTimeline] = useState<SessionTimelineExport | null>(null);
  const [corrections, setCorrections] = useState<SpeechCorrectionEntry[]>([]);
  const [audioUrl, setAudioUrl] = useState('');
  const [editing, setEditing] = useState<{ segment: ReviewTranscript; text: string; wrongText: string; correctText: string; learn: boolean; pairTouched: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('正在载入本场记录');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef('');

  const load = useCallback(async () => {
    const headers = accessHeaders(access.actorId, access.token);
    const [timelineResponse, correctionsResponse, audioResponse] = await Promise.all([
      fetch(`/api/session/${state.sessionId}/timeline`, { headers }),
      fetch(`/api/rooms/${state.roomId}/speech-corrections`, { headers }),
      fetch(`/api/session/${state.sessionId}/audio.wav`, { headers }),
    ]);
    if (!timelineResponse.ok) throw new Error('本场时间线读取失败');
    if (!correctionsResponse.ok) throw new Error('长期纠错词库读取失败');
    setTimeline(await timelineResponse.json() as SessionTimelineExport);
    setCorrections(await correctionsResponse.json() as SpeechCorrectionEntry[]);
    if (audioResponse.ok) {
      const nextUrl = URL.createObjectURL(await audioResponse.blob());
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = nextUrl;
      setAudioUrl(nextUrl);
    }
    setMessage(audioResponse.ok ? '' : '本场没有可播放的音频');
  }, [access.actorId, access.token, state.roomId, state.sessionId]);

  useEffect(() => {
    void load().catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)));
    const settleTimer = window.setTimeout(() => { void load().catch(() => undefined); }, 2_500);
    return () => {
      window.clearTimeout(settleTimer);
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, [load]);

  const transcripts = buildReviewTranscripts(timeline?.events ?? []);
  const beginEdit = (segment: ReviewTranscript) => setEditing({ segment, text: segment.text, wrongText: '', correctText: '', learn: true, pairTouched: false });
  const updateDraft = (text: string) => setEditing((current) => {
    if (!current) return null;
    const derived = deriveTextDifference(current.segment.text, text);
    return {
      ...current,
      text,
      ...(!current.pairTouched ? { wrongText: derived?.wrongText ?? '', correctText: derived?.correctText ?? '' } : {}),
    };
  });
  const saveCorrection = async () => {
    if (!editing?.text.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      const response = await fetch(`/api/session/${state.sessionId}/transcripts/${editing.segment.id}`, {
        method: 'PATCH',
        headers: accessHeaders(access.actorId, access.token, true),
        body: JSON.stringify({ text: editing.text.trim(), learn: editing.learn, wrongText: editing.wrongText.trim() || undefined, correctText: editing.correctText.trim() || undefined }),
      });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message ?? '转录纠错失败');
      setEditing(null);
      await load();
      setMessage(editing.learn && editing.wrongText && editing.correctText ? '转录已修正，并已加入直播间长期纠错词库' : '转录已修正');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const setSpeaker = async (segment: ReviewTranscript) => {
    setBusy(true);
    try {
      const speaker = segment.speaker === 'other' ? 'host' : 'other';
      const response = await fetch(`/api/session/${state.sessionId}/transcripts/${segment.id}`, {
        method: 'PATCH',
        headers: accessHeaders(access.actorId, access.token, true),
        body: JSON.stringify({ speaker }),
      });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message ?? '说话人标记失败');
      await load();
      setMessage(`已标记为${speaker === 'other' ? '其他人' : '主播'}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const setCorrectionEnabled = async (correction: SpeechCorrectionEntry) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/rooms/${state.roomId}/speech-corrections/${correction.id}/enabled`, {
        method: 'POST', headers: accessHeaders(access.actorId, access.token, true), body: JSON.stringify({ enabled: !correction.enabled }),
      });
      if (!response.ok) throw new Error('纠错词状态更新失败');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const playSegment = (segment: ReviewTranscript) => {
    if (!audioRef.current) return;
    audioRef.current.currentTime = Math.max(0, (segment.audioStartMs ?? segment.startOffsetMs ?? segment.offsetMs ?? 0) / 1_000);
    void audioRef.current.play();
  };
  const startNewSession = () => {
    localStorage.removeItem('live-session');
    window.location.assign(`/?room=${encodeURIComponent(state.roomId)}`);
  };

  return <div className="modal-backdrop" role="presentation"><section className="review-modal" role="dialog" aria-modal="true" aria-label="停播复核">
    <header className="review-head"><div><span className="section-kicker">停播复核 <span>SESSION REVIEW</span></span><h2>音频与转录校对</h2><p>{state.sessionId} · {transcripts.length} 条最终转录 · 长期纠错 {corrections.length} 条</p></div><div className="review-head-actions"><button type="button" className="new-session-button" onClick={startNewSession}><Plus size={15} />新开一场直播</button><button type="button" className="modal-close" onClick={onClose} title="关闭">×</button></div></header>
    <div className="review-audio"><div><FileAudio size={18} /><span><strong>本场 16 kHz 识别音频</strong><small>{timeline?.audio ? `${Math.round(timeline.audio.durationMs / 1000)} 秒 · ${Math.round(timeline.audio.byteLength / 1024)} KB` : '等待音频信息'}</small></span></div>{audioUrl ? <audio ref={audioRef} controls preload="metadata" src={audioUrl} /> : <span className="review-audio-empty">暂无音频</span>}</div>
    <div className="review-grid"><section className="review-transcripts"><div className="pane-head"><div><strong>时间戳转录</strong><span>点击播放按钮定位到对应音频</span></div></div><div className="review-transcript-list">{transcripts.map((segment) => <div className={`review-transcript-row ${segment.compliance?.risk ?? ''}`} key={segment.id}><button type="button" className="segment-play" onClick={() => playSegment(segment)} disabled={!audioUrl} title="播放对应音频"><Play size={13} fill="currentColor" /></button><time><span>{formatReplayOffset(segment.offsetMs)}</span><small>{new Date(segment.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</small><SpeakerTag speaker={segment.speaker} onClick={() => void setSpeaker(segment)} /></time><div className="review-transcript-copy">{editing?.segment.id === segment.id ? <form onSubmit={(event) => { event.preventDefault(); void saveCorrection(); }}><textarea value={editing.text} onChange={(event) => updateDraft(event.target.value)} autoFocus /><div className="correction-pair"><label>错误词<input value={editing.wrongText} onChange={(event) => setEditing({ ...editing, wrongText: event.target.value, pairTouched: true })} placeholder="自动提取" /></label><span>→</span><label>正确词<input value={editing.correctText} onChange={(event) => setEditing({ ...editing, correctText: event.target.value, pairTouched: true })} placeholder="自动提取" /></label></div><label className="learn-toggle"><input type="checkbox" checked={editing.learn} onChange={(event) => setEditing({ ...editing, learn: event.target.checked })} />加入当前直播间长期纠错词库</label><div className="review-edit-actions"><button type="submit" disabled={busy || !editing.text.trim()}><Save size={13} />保存纠错</button><button type="button" onClick={() => setEditing(null)}>取消</button></div></form> : <><p>{transcriptMarkup(segment.text, segment.compliance)}</p><div><span>{segment.revisions > 0 ? `已修正 ${segment.revisions} 次` : '原始转录'}</span><button type="button" title="纠正这句转录" onClick={() => beginEdit(segment)}><Pencil size={13} /></button></div></>}</div></div>)}</div>{transcripts.length === 0 && <div className="review-empty">本场还没有最终转录</div>}</section>
      <aside className="correction-library"><div className="pane-head"><div><strong>长期纠错词库</strong><span>下一场自动修正并加入识别上下文</span></div></div><div className="correction-list">{corrections.map((correction) => <div className={`correction-row ${correction.enabled ? '' : 'disabled'}`} key={correction.id}><div><strong>{correction.wrongText}</strong><span>→</span><strong>{correction.correctText}</strong></div><small>确认 {correction.confirmations} 次 · {correction.enabled ? '已生效' : '已停用'}</small><button type="button" disabled={busy} onClick={() => void setCorrectionEnabled(correction)}>{correction.enabled ? '停用' : '重新启用'}</button></div>)}</div>{corrections.length === 0 && <div className="review-empty">修正转录后可沉淀主播专属词库</div>}</aside></div>
    {message && <div className="review-message">{message}</div>}
  </section></div>;
}

function Waveform({ active }: { active: boolean }) {
  return <div className={`waveform ${active ? 'active' : ''}`} aria-hidden="true">{Array.from({ length: 32 }, (_, index) => <i key={index} style={{ '--bar': `${16 + ((index * 13) % 24)}%`, '--delay': `${index * 35}ms` } as React.CSSProperties} />)}</div>;
}

function SpeakerTag({ speaker = 'host', onClick }: { speaker?: SpeakerLabel; onClick?: () => void }) {
  const isOther = speaker === 'other';
  return <button type="button" className={`speaker-tag ${isOther ? 'other' : 'host'}`} onClick={onClick} title="标记说话人"><>{isOther ? <UsersRound size={11} /> : <UserRound size={11} />}</>{isOther ? '其他人' : '主播'}</button>;
}

function transcriptMarkup(text: string, result: Pick<ComplianceResult, 'risk' | 'matchedTerms'> | null | undefined) {
  const terms = [...new Set((result?.matchedTerms ?? []).map((term) => term.trim()).filter(Boolean))].sort((first, second) => second.length - first.length);
  if (terms.length === 0) return text;
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = new RegExp(terms.map(escapeRegExp).join('|'), 'giu');
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(matcher)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));
    nodes.push(<mark className={`transcript-risk-mark ${result?.risk ?? 'warning'}`} key={`${index}-${match[0]}`}>{match[0]}</mark>);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function TranscriptStage({ state, send }: { state: SessionState; send: (message: object) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const lastFinal = state.transcriptHistory[state.transcriptHistory.length - 1];
  const latestIsCurrent = lastFinal && lastFinal.timestamp >= state.productContextStartedAt;
  return <section className="stage-section transcript-stage">
    <div className="section-heading"><div><span className="section-kicker">豆包大模型流式语音识别 <span>ASR</span></span><h1>{state.partialTranscript || (latestIsCurrent ? lastFinal?.text : null) || '等待主播开口'}</h1></div><div className="asr-badge"><span className="signal-dot on" />{state.isListening ? '流式语音识别中' : '待识别'}</div></div>
    <Waveform active={state.isListening} />
    <div className="transcript-feed">{state.transcriptHistory.slice(-4).map((segment, index) => { const compliance = state.alerts.find((alert) => alert.segmentId === segment.id); return <div className={`feed-line ${index === state.transcriptHistory.slice(-4).length - 1 ? 'current' : ''} ${compliance?.risk ?? ''}`} key={segment.id}><time><span>{new Date(segment.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><em>{formatTranscriptOffset(segment.offsetMs)}</em><SpeakerTag speaker={segment.speaker} onClick={() => send({ type: 'transcript.speaker', segmentId: segment.id, speaker: segment.speaker === 'other' ? 'host' : 'other' })} /></time>{editingId === segment.id ? <form className="transcript-edit" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) { send({ type: 'transcript.correct', segmentId: segment.id, text: draft.trim(), learn: true }); setEditingId(null); } }}><input value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus /><button type="submit" title="保存并学习纠错"><Save size={13} /></button><button type="button" title="取消纠错" onClick={() => setEditingId(null)}>×</button></form> : <><span>{transcriptMarkup(segment.text, compliance)}</span>{segment.isFinal && <button type="button" className="transcript-edit-button" title="纠正这句转录" onClick={() => { setEditingId(segment.id); setDraft(segment.text); }}><Pencil size={12} /></button>}</>}</div>; })}</div>
  </section>;
}

function coachAlternatives(state: SessionState): CoachSuggestion[] {
  const current = state.coachSuggestions?.filter((suggestion) => suggestion.text.trim()) ?? [];
  const legacy = state.coachSuggestion && !current.some((suggestion) => suggestion.id === state.coachSuggestion?.id) ? [state.coachSuggestion] : [];
  const productFallbacks = [
    ...state.product.compliantPhrases,
    `${state.product.name}可以结合材质、规格和日常使用场景来了解。`,
    `大家最关心${state.product.name}哪个细节？评论区告诉我。`,
    '需要的朋友可以打开商品卡查看规格与实时价格。',
  ];
  const purposes: CoachSuggestion['purpose'][] = ['塑品', '互动', '转化'];
  const fallbackSuggestions = productFallbacks.map((text, index): CoachSuggestion => ({
    id: `display-fallback-${state.product.id}-${index}`,
    purpose: purposes[index % purposes.length],
    text,
    reason: index === 0 ? '介绍商品价值' : index === 1 ? '引导观众互动' : '承接购买动作',
    source: 'local-fallback',
    createdAt: state.lastEventAt,
  }));
  return [...current, ...legacy, ...fallbackSuggestions]
    .filter((suggestion, index, all) => all.findIndex((item) => item.text === suggestion.text) === index)
    .slice(0, 3);
}

function PromptPanel({ state, compact = false }: { state: SessionState; compact?: boolean }) {
  const latest = complianceForPrompt({ ...state, productId: state.product.id });
  const latestSegment = state.transcriptHistory.at(-1);
  const latestSegmentIsCurrent = Boolean(latestSegment && latestSegment.timestamp >= state.productContextStartedAt);
  const currentCompliance = complianceForLatestSegment(state);
  const pending = Boolean(state.partialTranscript || (latestSegmentIsCurrent && !currentCompliance));
  const coach = coachAlternatives(state)[0];
  const phrase = coach?.text || (latest && latest.risk !== 'safe'
    ? latest.alternative
    : state.product.compliantPhrases[0] || '根据商品页面信息介绍材质、规格和使用场景，价格与库存以页面实时信息为准。');
  return <section className={`prompt-panel ${latest?.risk ?? 'safe'} ${compact ? 'compact' : ''}`}>
    <div className="prompt-head"><div><span className="section-kicker">主播提词 <span>豆包直播教练</span></span><h2>{coach ? `${coach.purpose} · 下一句` : latest && latest.risk !== 'safe' ? '现在请替换为' : pending ? '分析中，先用安全表达' : '当前商品建议表达'}</h2></div><Sparkles size={20} /></div>
    <p className="prompt-quote">{phrase}</p>
    <div className="prompt-foot"><span><Keyboard size={14} />{state.coachPending ? '正在生成' : '建议照读'}</span><span className="prompt-product">{state.product.name}</span></div>
  </section>;
}

function formatAnalysisLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '等待响应';
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`;
}

function useAnalysisElapsed(pending: boolean, pendingSince: number | null): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!pending || pendingSince === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, [pending, pendingSince]);
  return pending && pendingSince !== null ? Math.max(0, now - pendingSince) : null;
}

function CompliancePanel({ result, pending = false, pendingSince = null }: { result: ComplianceResult | null; pending?: boolean; pendingSince?: number | null }) {
  const elapsedMs = useAnalysisElapsed(pending, pendingSince);
  const latency = pending ? elapsedMs : result?.analysisMs;
  const resolved = result ?? { risk: 'safe' as const, title: pending ? '正在分析当前话术' : '等待下一句', reason: pending ? '分析完成前先使用上方商品安全表达。' : '系统会在每个转录片段完成后即时分析。', policyRef: '豆包大模型 · 抖音直播规则', confidence: 0 };
  return <section className={`compliance-panel ${resolved.risk}`}>
    <div className="compliance-top"><div className="risk-pill"><RiskIcon risk={resolved.risk} /><span><RiskLabel risk={resolved.risk} /></span></div><div className="compliance-meta"><span className="analysis-latency">{pending ? `响应中 ${formatAnalysisLatency(latency)}` : latency === null || latency === undefined ? '实时监测' : `响应 ${formatAnalysisLatency(latency)}`}</span><span className="confidence">{resolved.confidence ? `${Math.round(resolved.confidence * 100)}% 置信` : ''}</span></div></div>
    <h3>{resolved.title}</h3><p>{resolved.reason}</p><div className="policy-ref"><ShieldCheck size={14} />{resolved.policyRef}</div>
  </section>;
}

function DemoInput({ state, send, access }: { state: SessionState; send: (message: object) => void; access: OperatorAccess }) {
  const [text, setText] = useState('');
  const [references, setReferences] = useState<PresenterPhrase[]>([]);
  const loadReferences = useCallback(() => {
    if (!state.presenterId || !state.roomId) return Promise.resolve();
    return fetch(`/api/presenters/${state.presenterId}/phrases?productId=${encodeURIComponent(state.product.id)}`, { headers: accessHeaders(access.actorId, access.token) })
      .then((response) => response.ok ? response.json() as Promise<PresenterPhrase[]> : [])
      .then((phrases) => { setReferences(phrases.filter((phrase) => phrase.status === 'reference').slice(0, 3)); })
      .catch(() => { setReferences([]); });
  }, [access.actorId, access.token, state.product.id, state.presenterId, state.roomId]);
  useEffect(() => {
    void loadReferences();
    const refresh = () => { void loadReferences(); };
    window.addEventListener('phrase-library-updated', refresh);
    return () => window.removeEventListener('phrase-library-updated', refresh);
  }, [loadReferences]);
  return <section className="demo-bar"><div className="demo-label"><ClipboardPaste size={15} />主播专属话术 <span>{references.length ? `${references.length} 条参考` : '本场结束后自动归档'}</span></div><div className="demo-actions">{references.map((phrase) => <button type="button" className="demo-chip" key={phrase.id} title="填入参考话术" onClick={() => setText(phrase.text)}>{phrase.text}</button>)}</div><form onSubmit={(event) => { event.preventDefault(); if (text.trim()) { send({ type: 'demo.transcript', text: text.trim() }); setText(''); } }} className="demo-form"><input value={text} onChange={(event) => setText(event.target.value)} placeholder="输入一句测试话术，或从主播专属库选择" /><button type="submit" title="发送模拟话术"><ArrowUpRight size={16} /></button></form></section>;
}

function PresenterPhrasePanel({ state, access, send }: { state: SessionState; access: OperatorAccess; send: (message: object) => boolean }) {
  const [presenters, setPresenters] = useState<PresenterProfile[]>([]);
  const [phrases, setPhrases] = useState<PresenterPhrase[]>([]);
  const [selectedPresenterId, setSelectedPresenterId] = useState(state.presenterId);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [purpose, setPurpose] = useState<PresenterPhrase['purpose']>('塑品');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [newPresenterName, setNewPresenterName] = useState('');

  useEffect(() => {
    if (selectedPresenterId && selectedPresenterId !== state.presenterId) send({ type: 'presenter.select', presenterId: selectedPresenterId });
  }, [selectedPresenterId, send, state.presenterId]);

  const headers = accessHeaders(access.actorId, access.token, true);
  const load = useCallback(async () => {
    const presentersResponse = await fetch(`/api/rooms/${state.roomId}/presenters`, { headers });
    if (!presentersResponse.ok) throw new Error('主播档案读取失败');
    const nextPresenters = await presentersResponse.json() as PresenterProfile[];
    setPresenters(nextPresenters);
    const activeId = nextPresenters.some((presenter) => presenter.id === selectedPresenterId) ? selectedPresenterId : nextPresenters[0]?.id;
    if (!activeId) return setPhrases([]);
    setSelectedPresenterId(activeId);
    const phrasesResponse = await fetch(`/api/presenters/${activeId}/phrases`, { headers });
    if (!phrasesResponse.ok) throw new Error('主播话术读取失败');
    setPhrases(await phrasesResponse.json() as PresenterPhrase[]);
  }, [access.actorId, access.token, selectedPresenterId, state.roomId]);

  useEffect(() => { void load().catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error))); }, [load]);

  const save = async () => {
    if (!draft.trim() || !selectedPresenterId) return;
    setBusy(true); setMessage('');
    try {
      const url = editingId ? `/api/phrases/${editingId}` : `/api/presenters/${selectedPresenterId}/phrases`;
      const response = await fetch(url, { method: editingId ? 'PATCH' : 'POST', headers, body: JSON.stringify({ text: draft, productId: state.product.id, purpose }) });
      const body = await response.json() as PresenterPhrase & { message?: string };
      if (!response.ok) throw new Error(body.message ?? '话术保存失败');
      setDraft(''); setEditingId(null); await load(); window.dispatchEvent(new Event('phrase-library-updated')); setMessage('已保存为草稿，选定后才会用于下一场');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const action = async (phrase: PresenterPhrase, type: 'reference' | 'rewrite' | 'rollback') => {
    setBusy(true); setMessage('');
    try {
      const url = type === 'reference' ? `/api/phrases/${phrase.id}/reference` : type === 'rewrite' ? `/api/phrases/${phrase.id}/rewrite` : `/api/phrases/${phrase.id}/rollback`;
      const body = type === 'reference' ? { selected: phrase.status !== 'reference' } : type === 'rollback' ? { targetVersion: Math.max(1, phrase.version - 1) } : {};
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message ?? '话术操作失败');
      await load(); window.dispatchEvent(new Event('phrase-library-updated')); setMessage(type === 'rewrite' ? '豆包已生成新草稿，请确认后选定' : type === 'reference' ? '参考状态已更新' : '已回滚到上一版');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  const createPresenter = async () => {
    if (!newPresenterName.trim()) return;
    setBusy(true); setMessage('');
    try {
      const roomResponse = await fetch(`/api/rooms/${state.roomId}`, { headers });
      const room = await roomResponse.json() as LiveRoom;
      const response = await fetch(`/api/rooms/${state.roomId}/presenters`, { method: 'POST', headers, body: JSON.stringify({ name: newPresenterName, accountName: room.accountName }) });
      const body = await response.json() as PresenterProfile & { message?: string };
      if (!response.ok) throw new Error(body.message ?? '主播档案创建失败');
      setNewPresenterName(''); setSelectedPresenterId(body.id); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return <section className="phrase-library-pane"><div className="pane-head"><div><strong>主播专属话术库</strong><span>本地优先 · 归档、改写、选定后用于下一场</span></div><button type="button" title="刷新" onClick={() => void load()}><RefreshCw size={14} /></button></div><div className="phrase-presenter-row"><select value={selectedPresenterId} onChange={(event) => { setSelectedPresenterId(event.target.value); }} aria-label="选择主播">{presenters.map((presenter) => <option key={presenter.id} value={presenter.id}>{presenter.name} · {presenter.accountName}</option>)}</select><input value={newPresenterName} onChange={(event) => setNewPresenterName(event.target.value)} placeholder="新增主播名称" /><button type="button" disabled={busy || !newPresenterName.trim()} onClick={() => void createPresenter()}><Plus size={14} />新增主播</button></div><div className="phrase-editor"><select value={purpose} onChange={(event) => setPurpose(event.target.value as PresenterPhrase['purpose'])} aria-label="话术作用"><option value="塑品">塑品</option><option value="憋单">憋单</option><option value="逼单">逼单</option><option value="转化">转化</option><option value="互动">互动</option><option value="留人">留人</option><option value="答疑">答疑</option></select><textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="输入主播常用话术或头部直播间参考话术" /><button type="button" className="primary-wide" disabled={busy || !draft.trim() || !selectedPresenterId} onClick={() => void save()}><Save size={15} />{editingId ? '保存新版本' : '保存草稿'}</button></div><div className="phrase-list">{phrases.length === 0 ? <div className="phrase-empty">本场结束后，主播说过的话会自动归档到这里。</div> : phrases.map((phrase) => <article className={`phrase-row ${phrase.status}`} key={phrase.id}><div><span className="phrase-status">{phrase.status === 'reference' ? '下一场参考' : phrase.status === 'retired' ? '已停用' : '草稿'}</span><strong>{phrase.text}</strong><small>{phrase.productId === null ? '通用话术' : phrase.productId === state.product.id ? state.product.name : '其他商品'} · v{phrase.version} · {phrase.source === 'imported' ? '外部录入' : phrase.source === 'doubao' ? '豆包改写' : phrase.source === 'session' ? '本场归档' : '人工'}</small></div><div className="phrase-actions"><button type="button" disabled={busy} onClick={() => { setEditingId(phrase.id); setDraft(phrase.text); setPurpose(phrase.purpose ?? '塑品'); }}>编辑</button><button type="button" disabled={busy} onClick={() => void action(phrase, 'rewrite')} title="用豆包生成新的草稿"><Sparkles size={13} />改写</button><button type="button" disabled={busy} onClick={() => void action(phrase, 'reference')}>{phrase.status === 'reference' ? '取消参考' : '选为参考'}</button>{phrase.version > 1 && <button type="button" disabled={busy} onClick={() => void action(phrase, 'rollback')}>回滚</button>}</div></article>)}</div>{message && <div className="workspace-message">{message}</div>}</section>;
}

function SessionStats({ state }: { state: SessionState }) {
  return <div className="session-stats"><div><span>已播时长</span><strong>{Math.floor(state.stats.speakingSeconds / 60).toString().padStart(2, '0')}:{(state.stats.speakingSeconds % 60).toString().padStart(2, '0')}</strong></div><div><span>识别字数</span><strong>{state.stats.words}</strong></div><div><span>高风险</span><strong className="danger-text">{state.stats.blockedCount}</strong></div><div><span>需留意</span><strong className="warning-text">{state.stats.warningCount}</strong></div></div>;
}

function RiskProfileControl({ state, send }: { state: SessionState; send: (message: object) => void }) {
  const profiles = [
    { value: 'strict' as const, label: '严审' },
    { value: 'balanced' as const, label: '均衡' },
    { value: 'optimized' as const, label: '优化' },
  ];
  return <div className="risk-profile-control" role="group" aria-label="本场风险档位">{profiles.map((profile) => <button type="button" className={state.riskProfile === profile.value ? 'active' : ''} key={profile.value} onClick={() => send({ type: 'risk.profile', profile: profile.value })}>{profile.label}</button>)}</div>;
}

function LoginScreen({ readiness, message, onLogin }: { readiness: Readiness | null; message: string; onLogin: (actorId: string, password: string) => Promise<void> }) {
  const [actorId, setActorId] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const localOnlyBlocked = readiness && !readiness.auth.configured;
  return <div className="access-shell"><div className="access-brand"><span className="brand-mark"><ShieldCheck size={19} /></span><strong>dypro</strong></div><section className="access-panel"><div className="access-icon"><LockKeyhole size={23} /></div><span className="section-kicker">控制台身份 <span>DYPRO ACCESS</span></span><h1>{localOnlyBlocked ? '当前设备仅可查看主播屏' : '登录直播控制台'}</h1>{localOnlyBlocked ? <p>多人账号尚未配置，控制操作仅允许在 MacBook 本机完成。</p> : <form onSubmit={(event) => { event.preventDefault(); setBusy(true); void onLogin(actorId.trim(), password).finally(() => setBusy(false)); }}><label>账号<input value={actorId} onChange={(event) => setActorId(event.target.value)} autoComplete="username" /></label><label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label><button type="submit" disabled={busy || !actorId.trim() || !password}><LockKeyhole size={15} />{busy ? '正在登录' : '登录'}</button></form>}{message && <div className="access-message">{message}</div>}</section></div>;
}

function OperatorScreen({ access, onLogout }: { access: OperatorAccess; onLogout: () => void }) {
  const session = useLiveSession('operator', access);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const currentCompliance = complianceForLatestSegment(session.state);
  const latestSegment = session.state.transcriptHistory.at(-1);
  const latestSegmentIsCurrent = Boolean(latestSegment && latestSegment.timestamp >= session.state.productContextStartedAt);
  const compliancePending = Boolean(session.state.partialTranscript || (latestSegmentIsCurrent && !currentCompliance));
  return <div className="app-shell operator-shell"><AppHeader state={session.state} connected={session.connected} status={session.status} mode="operator" access={access} /><main className="operator-grid"><aside className="left-rail"><ProductRail state={session.state} send={session.send} onOpenLibrary={() => setWorkspaceOpen(true)} /><MicPanel state={session.state} connected={session.connected} captureDeniedVersion={session.captureDeniedVersion} send={session.send} onOpenReview={() => setReviewOpen(true)} /><div className="rail-footer"><Wifi size={14} />局域网地址可供 iPad 访问</div></aside><section className="main-stage"><div className="stage-context"><div><span className="eyebrow">TODAY'S LIVE · 01</span><h2>{session.state.product.name}</h2></div><RiskProfileControl state={session.state} send={session.send} /></div><TranscriptStage state={session.state} send={session.send} /><DemoInput state={session.state} send={session.send} access={access} /></section><aside className="coach-rail"><PromptPanel state={session.state} /><CompliancePanel result={currentCompliance} pending={compliancePending} pendingSince={session.analysisStartedAt} /><section className="alert-history"><div className="section-kicker">近期提醒 <span>ALERT LOG</span></div>{session.state.alerts.length ? session.state.alerts.slice(0, 4).map((alert) => <div className="alert-row" key={alert.id}><div className={`alert-icon ${alert.risk}`}><RiskIcon risk={alert.risk} /></div><div><strong>{alert.title}</strong><small>{new Date(alert.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · {alert.alternative.replace(/^可以改为：/u, '')}</small></div></div>) : <div className="empty-alert"><Check size={16} />暂无风险提醒</div>}</section></aside></main><footer className="operator-footer"><SessionStats state={session.state} /><div className="footer-note"><Activity size={15} />风险判断以豆包大模型为主，未配置密钥时使用本地规则即时兜底</div></footer>{workspaceOpen && <WorkspaceModal state={session.state} access={access} send={session.send} onClose={() => setWorkspaceOpen(false)} onLogout={onLogout} />}{reviewOpen && <SessionReviewModal state={session.state} access={access} onClose={() => setReviewOpen(false)} />}</div>;
}

function OperatorEntry() {
  const auth = useOperatorAccess();
  if (auth.loading) return <div className="access-shell"><div className="access-loading">正在验证控制台身份</div></div>;
  if (!auth.access) return <LoginScreen readiness={auth.readiness} message={auth.message} onLogin={auth.login} />;
  return <OperatorScreen access={auth.access} onLogout={auth.logout} />;
}

function DisplayScreen() {
  const session = useLiveSession('display');
  const result = complianceForLatestSegment(session.state);
  const promptCompliance = complianceForPrompt({ ...session.state, productId: session.state.product.id });
  const suggestions = coachAlternatives(session.state);
  const latestTranscript = session.state.transcriptHistory.at(-1);
  const latestSegment = latestTranscript && latestTranscript.timestamp >= session.state.productContextStartedAt ? latestTranscript : undefined;
  const latestSegmentIsCurrent = Boolean(latestSegment && latestSegment.timestamp >= session.state.productContextStartedAt);
  const pending = Boolean(session.state.partialTranscript || (latestSegmentIsCurrent && !result));
  const elapsedMs = useAnalysisElapsed(pending, session.analysisStartedAt);
  const latency = pending ? elapsedMs : result?.analysisMs;
  const risk = result?.risk ?? (promptCompliance?.risk !== 'safe' ? promptCompliance?.risk ?? 'safe' : 'safe');
  const hasRetainedReplacement = promptCompliance?.risk === 'warning' || promptCompliance?.risk === 'blocked';
  const captureLabel = session.state.captureState === 'live' ? '正在收音' : session.state.captureState === 'paused' ? '直播暂停' : session.state.captureState === 'ended' ? '直播结束' : '等待开播';
  const coachLatency = suggestions.find((suggestion) => suggestion.latencyMs !== undefined)?.latencyMs;
  const riskAlternative = promptCompliance && promptCompliance.risk !== 'safe' ? promptCompliance.alternative.replace(/^可以改为：/u, '') : '';
  return <div className={`app-shell display-shell risk-${risk}`}>
    <AppHeader state={session.state} connected={session.connected} status={session.status} mode="display" />
    <main className="display-main">
      <div className="display-product"><img src={session.state.product.image} alt="" /><div><span className="eyebrow">ON AIR PRODUCT · {session.state.product.category}</span><h1>{session.state.product.name}</h1><strong>{session.state.product.price}</strong></div><div className="display-live"><span className={`signal-dot ${session.state.isListening ? 'on' : ''}`} />{captureLabel}</div></div>
      <section className="display-coach-cues">
        <header><div><span className="eyebrow">主播提词 · 下一句</span><h2>三段备选话术</h2></div><div className="display-meta"><span className="display-source">{session.state.coachPending ? '豆包生成中' : suggestions[0]?.source === 'doubao' ? '豆包直播教练' : '主播专属参考'}</span><span className="display-latency">{session.state.coachPending ? '实时更新' : coachLatency === undefined ? '随时参考' : `教练 ${formatAnalysisLatency(coachLatency)}`}</span></div></header>
        <div className="display-coach-list">{suggestions.map((suggestion, index) => <article className="display-coach-item" key={suggestion.id}><div><span>{index + 1}</span><strong>{suggestion.purpose}</strong></div><p>{suggestion.text}</p><small>{suggestion.reason}</small></article>)}</div>
      </section>
      <section className={`display-alert ${risk}`}>
        <div className="display-alert-head"><div className="display-risk-icon"><RiskIcon risk={risk} /></div><div><span className="eyebrow">风险预警</span><h2>{result ? <RiskLabel risk={risk} /> : hasRetainedReplacement ? '替换话术保持显示' : pending ? '正在分析当前话术' : '当前未发现高风险表达'}</h2></div><div className="display-meta"><span className="display-source">{pending ? 'ANALYZING' : promptCompliance?.source === 'custom-rule' ? 'CUSTOM RULE' : 'LOCAL GUARDRAIL'}</span><span className="display-latency">{pending ? `响应中 ${formatAnalysisLatency(latency)}` : latency === null || latency === undefined ? '实时监测' : `响应 ${formatAnalysisLatency(latency)}`}</span></div></div>
        {(riskAlternative || result?.reason) && <div className="display-risk-detail">{riskAlternative && <p>{riskAlternative}</p>}{result?.reason && <small><AlertTriangle size={14} />{result.reason}</small>}</div>}
      </section>
    </main>
    <footer className="display-footer"><div><ShieldCheck size={15} />抖音直播合规预警</div><div className="display-footer-stats"><span>监测 {session.state.stats.words} 字</span><span>高风险 {session.state.stats.blockedCount}</span><span>需留意 {session.state.stats.warningCount}</span></div></footer>
  </div>;
}

export default function App() {
  return window.location.pathname.startsWith('/display') || window.location.pathname.startsWith('/screen/') ? <DisplayScreen /> : <OperatorEntry />;
}
