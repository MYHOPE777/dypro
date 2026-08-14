import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  Archive,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleStop,
  Clock3,
  Copy,
  Database,
  ExternalLink,
  History,
  Mic,
  MonitorUp,
  Package,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  QrCode,
  Save,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
  UserRound,
  UsersRound,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import { LiveSessionClient } from './clients/liveSessionClient';
import { SessionReviewClient } from './clients/sessionReviewClient';
import { CatalogClient } from './clients/catalogClient';
import { DisplayLinkClient, type DisplayLink } from './clients/displayLinkClient';
import { AuthClient } from './clients/authClient';
import { V2_AUTH_REQUIRED_EVENT } from './clients/authHeaders';
import { DEFAULT_PRODUCT, PRODUCTS } from './shared/products';
import type { ComplianceFinding, ComplianceResult, ComplianceRule, CoachPurpose, ManualSyncJob, PresenterPhrase, PresenterProfile, Product, RuleDocument, RuleUnit, TranscriptSegment } from './shared/types';
import type { LiveCommand, LiveSessionSnapshot, SessionReview, SessionSummary } from './shared/v2';
import type { AudioTrack } from './shared/v2Audio';

const EMPTY: LiveSessionSnapshot = {
  sessionId: '', tenantId: 'tenant-local', roomId: 'room-default', presenterId: 'presenter-default', presenterName: '默认主播', lifecycle: 'idle',
  product: DEFAULT_PRODUCT, lineup: PRODUCTS, partialTranscript: '', transcriptHistory: [], latestCompliance: null, alerts: [], coachSuggestions: [], coachPending: false,
  riskProfile: 'strict', stats: { speakingSeconds: 0, words: 0, blockedCount: 0, warningCount: 0, safeCount: 0 }, contentRevision: 0, latestSequence: 0, createdAt: Date.now(), updatedAt: Date.now(),
};

function currentDisplayAlias(): string | undefined {
  const match = window.location.pathname.match(/^\/screen\/([a-z0-9]{8})\/?$/iu);
  return match?.[1]?.toUpperCase();
}

function currentSessionId(useStoredSession = true): string | undefined {
  return new URLSearchParams(window.location.search).get('session')
    ?? (useStoredSession ? localStorage.getItem('v2-live-session') : null)
    ?? undefined;
}

function useLive(role: 'operator' | 'display') {
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [products, setProducts] = useState<Product[]>(PRODUCTS);
  const [status, setStatus] = useState('正在连接');
  const [connected, setConnected] = useState(false);
  const clientRef = useRef<LiveSessionClient | null>(null);

  useEffect(() => {
    const displayAlias = role === 'display' ? currentDisplayAlias() : undefined;
    const client = new LiveSessionClient({ role, roomId: 'room-default', displayAlias, sessionId: currentSessionId(!displayAlias) });
    clientRef.current = client;
    const unsubscribe = client.subscribe((next) => {
      setSnapshot(next);
      setProducts([...client.products]);
      setConnected(client.connected);
      if (next.sessionId) {
        localStorage.setItem('v2-live-session', next.sessionId);
        const query = new URLSearchParams(window.location.search);
        if (role === 'operator' && query.get('session') !== next.sessionId) {
          query.set('session', next.sessionId);
          window.history.replaceState(null, '', `${window.location.pathname}?${query}`);
        }
      }
    });
    const unsubscribeStatus = client.onStatus((next) => { setStatus(next); setConnected(client.connected); });
    client.connect();
    return () => { unsubscribe(); unsubscribeStatus(); client.close(); clientRef.current = null; };
  }, [role]);

  const send = useCallback((command: LiveCommand) => clientRef.current?.send(command) ?? false, []);
  const sendAudio = useCallback((pcm: ArrayBuffer | Uint8Array, sampleRate?: number, track?: AudioTrack, channels?: number) => clientRef.current?.sendAudio(pcm, sampleRate, track, channels) ?? false, []);
  return { snapshot, products, status, connected, send, sendAudio };
}

function pcm16(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) pcm[index] = Math.max(-1, Math.min(1, samples[index])) * 0x7fff;
  const bytes = new Uint8Array(pcm.byteLength);
  bytes.set(new Uint8Array(pcm.buffer));
  return bytes;
}

function resample(samples: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) return samples.slice();
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.max(1, Math.round(samples.length / ratio)));
  for (let index = 0; index < output.length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const weight = position - left;
    output[index] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return output;
}

function useMicrophone(sendAudio: (pcm: ArrayBuffer | Uint8Array, sampleRate?: number, track?: AudioTrack, channels?: number) => boolean) {
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const stopCapture = useCallback(() => {
    processorRef.current?.disconnect();
    contextRef.current?.close().catch(() => undefined);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    processorRef.current = null;
    contextRef.current = null;
    streamRef.current = null;
    setCapturing(false);
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
      setDevices(inputs);
      setDeviceId((current) => current && inputs.some((device) => device.deviceId === current) ? current : inputs[0]?.deviceId ?? '');
    } catch {
      // Device enumeration may be blocked until microphone permission is granted.
    }
  }, []);

  useEffect(() => {
    void refreshDevices();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return () => stopCapture();
    mediaDevices.addEventListener('devicechange', refreshDevices);
    return () => { mediaDevices.removeEventListener('devicechange', refreshDevices); stopCapture(); };
  }, [refreshDevices, stopCapture]);

  const start = useCallback(async (requestedDeviceId = deviceId): Promise<boolean> => {
    setError('');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风收音');
      stopCapture();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        ...(requestedDeviceId ? { deviceId: { exact: requestedDeviceId } } : {}),
      } });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (event) => {
        const samples = event.inputBuffer.getChannelData(0);
        const sourceRate = event.inputBuffer.sampleRate || context.sampleRate;
        sendAudio(pcm16(samples), sourceRate, 'source', 1);
        sendAudio(pcm16(resample(samples, sourceRate, 16_000)), 16_000, 'asr', 1);
      };
      source.connect(processor);
      processor.connect(context.destination);
      streamRef.current = stream;
      contextRef.current = context;
      processorRef.current = processor;
      setCapturing(true);
      const activeDeviceId = stream.getAudioTracks()[0]?.getSettings().deviceId;
      if (activeDeviceId) setDeviceId(activeDeviceId);
      void refreshDevices();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法使用麦克风');
      stopCapture();
      return false;
    }
  }, [deviceId, refreshDevices, sendAudio, stopCapture]);

  const selectDevice = useCallback(async (nextDeviceId: string): Promise<boolean> => {
    setDeviceId(nextDeviceId);
    if (capturing) return start(nextDeviceId);
    return true;
  }, [capturing, start]);

  return { capturing, error, devices, deviceId, start, stop: stopCapture, refreshDevices, selectDevice };
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function lifecycleText(lifecycle: LiveSessionSnapshot['lifecycle']): string {
  return ({ idle: '待开播', live: '直播中', paused: '已暂停', ending: '正在收尾', ended: '已结束' })[lifecycle];
}

function riskText(risk: ComplianceResult['risk'] | undefined): string {
  return risk === 'blocked' ? '高风险' : risk === 'warning' ? '需注意' : '表达安全';
}

function riskEvidence(text: string, terms: string[]): ReactNode {
  const matches = terms
    .map((term) => term.trim())
    .filter((term, index, all) => term && all.indexOf(term) === index)
    .map((term) => ({ term, index: text.indexOf(term) }))
    .filter((match) => match.index >= 0)
    .sort((left, right) => left.index - right.index || right.term.length - left.term.length);
  if (matches.length === 0) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue;
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(<mark key={`${match.index}-${match.term}`} className="v2-risk-term">{match.term}</mark>);
    cursor = match.index + match.term.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function SpeakerBadge({ segment }: { segment: TranscriptSegment }) {
  const automatic = segment.speakerSource === 'automatic';
  return <span className={`v2-speaker ${segment.speaker === 'other' ? 'other' : 'host'} ${automatic ? 'automatic' : ''}`}>
    {segment.speaker === 'other' ? <UsersRound size={11} /> : <UserRound size={11} />}
    {segment.speaker === 'other' ? '其他人' : automatic ? `${segment.speakerId ?? '待确认'}` : '主播'}
  </span>;
}

function TranscriptFeed({ snapshot, compact = false }: { snapshot: LiveSessionSnapshot; compact?: boolean }) {
  const items = snapshot.transcriptHistory.slice(compact ? -4 : -8);
  return <section className={`v2-transcript ${compact ? 'compact' : ''}`}>
    <header><div><span>实时转录</span><strong>{snapshot.partialTranscript ? '识别中' : '已同步'}</strong></div><small>共 {snapshot.transcriptHistory.length} 段</small></header>
    {snapshot.partialTranscript && <div className="v2-partial"><span>···</span><p>{snapshot.partialTranscript}</p></div>}
    <div className="v2-transcript-list">
      {items.map((segment) => <article key={segment.id}><time>{formatTime(segment.timestamp)}</time><SpeakerBadge segment={segment} /><p>{segment.text}</p></article>)}
      {!items.length && !snapshot.partialTranscript && <div className="v2-empty">开始收音后，识别结果会出现在这里</div>}
    </div>
  </section>;
}

function CoachBoard({ snapshot, display = false }: { snapshot: LiveSessionSnapshot; display?: boolean }) {
  const suggestions = snapshot.coachSuggestions.length ? snapshot.coachSuggestions : [
    { id: 'empty-1', purpose: '塑品' as const, text: `可以先介绍${snapshot.product.name}的核心使用场景。`, reason: '建立商品价值', source: 'local-fallback' as const, createdAt: Date.now() },
    { id: 'empty-2', purpose: '互动' as const, text: '问问大家最想了解哪个细节，再按页面信息逐项说明。', reason: '引导评论互动', source: 'local-fallback' as const, createdAt: Date.now() },
    { id: 'empty-3', purpose: '转化' as const, text: '需要的朋友可以打开商品卡，确认规格和实时价格。', reason: '承接下单动作', source: 'local-fallback' as const, createdAt: Date.now() },
  ];
  const doubaoSuggestionCount = suggestions.filter((suggestion) => suggestion.source === 'doubao').length;
  const coachStatus = snapshot.coachPending
    ? '豆包正在预测合规下一句'
    : doubaoSuggestionCount === 3
      ? '豆包生成 · 三段合规话术'
      : doubaoSuggestionCount > 0
        ? `豆包生成 ${doubaoSuggestionCount} 段 · 本地安全补足`
        : '本地安全备选 · 三段话术';
  return <section className={`v2-coach-board ${display ? 'display' : ''}`}>
    <header><div><Sparkles size={16} /><span>主播下一句</span></div><small>{coachStatus}</small></header>
    <div className="v2-coach-grid">{suggestions.slice(0, 3).map((suggestion, index) => <article key={suggestion.id}><div><b>{index + 1}</b><strong>{suggestion.purpose}</strong></div><p>{suggestion.text}</p><small>{suggestion.reason}</small></article>)}</div>
  </section>;
}

function RiskPanel({ snapshot, display = false, findings = [], onConfirmFinding, onDismissFinding, onOpenInbox }: { snapshot: LiveSessionSnapshot; display?: boolean; findings?: ComplianceFinding[]; onConfirmFinding?: (finding: ComplianceFinding) => Promise<void>; onDismissFinding?: (finding: ComplianceFinding) => Promise<void>; onOpenInbox?: () => void }) {
  const result = snapshot.latestCompliance;
  const risk = result?.risk ?? 'safe';
  const [confirmation, setConfirmation] = useState<{ resultId: string; message: string }>({ resultId: '', message: '' });
  const handle = async (finding: ComplianceFinding, action: 'confirm' | 'dismiss') => {
    const task = action === 'confirm' ? onConfirmFinding : onDismissFinding;
    if (!task) return;
    setConfirmation({ resultId: finding.id, message: action === 'confirm' ? '正在生成本地规则' : '正在标记误判' });
    try { await task(finding); setConfirmation({ resultId: finding.id, message: action === 'confirm' ? '已保存到本地规则库' : '已标记误判' }); } catch (error) { setConfirmation({ resultId: finding.id, message: error instanceof Error ? error.message : String(error) }); }
  };
  const terms = result?.matchedTerms?.filter((term) => term.trim()) ?? [];
  return <section className={`v2-risk-panel ${risk} ${display ? 'display' : ''}`}>
    <header><div>{risk === 'safe' ? <CheckCircle2 size={17} /> : <ShieldAlert size={17} />}<strong>{riskText(risk)}</strong></div><span>{result ? `置信度 ${Math.round(result.confidence * 100)}%` : ''}{typeof result?.analysisMs === 'number' ? ` · ${result.analysisMs}ms` : ''}</span></header>
    <h3>{result?.title ?? '当前没有风险提醒'}</h3>
    <p>{result?.reason ?? '本地规则会持续检查主播表达，模型判断完成后会在这里更新。'}</p>
    {result && risk !== 'safe' && <div className="v2-risk-evidence"><span>具体违规原话</span><blockquote>{riskEvidence(result.transcript, terms)}</blockquote>{terms.length > 0 && <small>命中片段：{terms.join('、')}</small>}</div>}
    {result && risk !== 'safe' && <div className="v2-risk-advice"><span>建议替换</span><strong>{result.alternative.replace(/^可以改为：/u, '')}</strong></div>}
    {!display && <div className="v2-risk-inbox"><header><span>待处置风险</span><strong>待处置 {findings.length}</strong></header>{findings.slice(0, 4).map((finding) => <article key={finding.id}><div><i className={finding.result.risk} /><strong>{finding.result.title}</strong><time>{formatTime(finding.createdAt)}</time></div><p>{finding.result.transcript}</p><small>{finding.productName} · 置信度 {Math.round(finding.result.confidence * 100)}%</small><footer><button type="button" disabled={confirmation.resultId === finding.id && confirmation.message.startsWith('正在')} onClick={() => void handle(finding, 'confirm')}><CheckCircle2 size={12} />确认成规则</button><button type="button" disabled={confirmation.resultId === finding.id && confirmation.message.startsWith('正在')} onClick={() => void handle(finding, 'dismiss')}>标记误判</button></footer>{confirmation.resultId === finding.id && confirmation.message && <em>{confirmation.message}</em>}</article>)}{confirmation.message && !findings.some((finding) => finding.id === confirmation.resultId) && <p className="v2-risk-inbox-result">{confirmation.message}</p>}{findings.length === 0 && <p className="v2-risk-inbox-empty">当前没有等待处理的风险</p>}{onOpenInbox && <button type="button" className="v2-risk-inbox-open" onClick={onOpenInbox}>打开风险规则控制台</button>}</div>}
  </section>;
}

function ProductRail({ snapshot, products, send, openHistory, openLibrary }: { snapshot: LiveSessionSnapshot; products: Product[]; send: (command: LiveCommand) => boolean; openHistory: () => void; openLibrary: () => void }) {
  return <aside className="v2-left-rail">
    <section><header><Package size={15} /><span>本场商品</span></header><div className="v2-product-list">{products.map((product) => <button type="button" className={snapshot.product.id === product.id ? 'active' : ''} key={product.id} onClick={() => send({ type: 'select_product', productId: product.id })}><img src={product.image} alt="" /><span><strong>{product.name}</strong><small>{product.category} · {product.price}</small></span></button>)}</div></section>
    <section className="v2-risk-profile"><header><ShieldAlert size={15} /><span>风控等级</span></header><div><button type="button" className="active" aria-pressed="true" disabled>严格</button></div><small>全场统一严格审核</small></section>
    <button type="button" className="v2-history-button" onClick={openLibrary}><BookOpen size={15} />资料管理</button>
    <button type="button" className="v2-history-button secondary" onClick={openHistory}><History size={15} />历史复核</button>
  </aside>;
}

function LiveControls({ snapshot, connected, status, send, sendAudio }: { snapshot: LiveSessionSnapshot; connected: boolean; status: string; send: (command: LiveCommand) => boolean; sendAudio: (pcm: ArrayBuffer | Uint8Array, sampleRate?: number, track?: AudioTrack, channels?: number) => boolean }) {
  const microphone = useMicrophone(sendAudio);
  const [devicePickerOpen, setDevicePickerOpen] = useState(false);
  const selectedDevice = microphone.devices.find((device) => device.deviceId === microphone.deviceId);
  const begin = async () => {
    if (!await microphone.start()) return;
    setDevicePickerOpen(false);
    send({ type: snapshot.lifecycle === 'paused' ? 'resume' : 'start' });
  };
  const changeDevice = async (nextDeviceId: string) => { if (!await microphone.selectDevice(nextDeviceId) && snapshot.lifecycle === 'live') send({ type: 'pause' }); };
  const pause = () => { microphone.stop(); send({ type: 'pause' }); };
  const end = () => { microphone.stop(); send({ type: 'end' }); };
  return <div className="v2-live-controls">
    <div className={`v2-connection ${connected ? 'online' : ''}`}><i />{status}</div>
    <div className="v2-device-picker">
      <button type="button" className="device" aria-label={`选择输入设备${selectedDevice?.label ? `，当前 ${selectedDevice.label}` : ''}`} aria-expanded={devicePickerOpen} onClick={() => { setDevicePickerOpen((open) => !open); void microphone.refreshDevices(); }}><Mic size={14} /><span><strong>选择输入设备</strong><small>{selectedDevice?.label || (microphone.deviceId ? '已选择麦克风' : '系统默认麦克风')}</small></span><ChevronDown size={13} /></button>
      {devicePickerOpen && <div className="v2-device-menu"><label htmlFor="v2-audio-input">收音设备</label><select id="v2-audio-input" value={microphone.deviceId} onChange={(event) => void changeDevice(event.target.value)}><option value="">系统默认麦克风</option>{microphone.devices.map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `麦克风 ${index + 1}`}</option>)}</select><button type="button" onClick={() => void microphone.refreshDevices()}><RefreshCw size={12} />刷新设备</button></div>}
    </div>
    {(snapshot.lifecycle === 'idle' || snapshot.lifecycle === 'paused') && <button type="button" className="primary" onClick={() => void begin()} disabled={!connected}><Mic size={15} />{snapshot.lifecycle === 'paused' ? '继续录制' : '开启直播录制'}</button>}
    {snapshot.lifecycle === 'live' && <button type="button" onClick={pause}><Pause size={15} />暂停录制</button>}
    {snapshot.lifecycle !== 'idle' && snapshot.lifecycle !== 'ended' && <button type="button" className="danger" onClick={end} disabled={snapshot.lifecycle === 'ending'}><CircleStop size={15} />{snapshot.lifecycle === 'ending' ? '正在结束' : '结束本场'}</button>}
    {microphone.error && <span className="v2-control-error">{microphone.error}</span>}
  </div>;
}

function DemoInput({ snapshot, send }: { snapshot: LiveSessionSnapshot; send: (command: LiveCommand) => boolean }) {
  const [text, setText] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); if (!text.trim()) return; send({ type: 'demo_transcript', text: text.trim() }); setText(''); };
  const examples = snapshot.product.compliantPhrases.slice(0, 2);
  return <section className="v2-demo"><span>对应商品参考话术</span><div>{examples.map((example) => <button type="button" key={example} onClick={() => send({ type: 'demo_transcript', text: example })}>{example}</button>)}</div><form onSubmit={submit}><input value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴或输入主播话术进行核验" /><button type="submit" title="提交"><Send size={14} /></button></form></section>;
}

function DisplayLinkPanel({ sessionId }: { sessionId: string }) {
  const client = useMemo(() => new DisplayLinkClient(), []);
  const [expanded, setExpanded] = useState(false);
  const [link, setLink] = useState<DisplayLink | null>(null);
  const [qrCode, setQrCode] = useState('');
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const linkUrl = link ? new URL(link.path, window.location.origin).toString() : '';

  useEffect(() => {
    if (!expanded || !sessionId || link?.sessionId === sessionId) return;
    let active = true;
    setMessage('正在生成入口');
    setLink(null);
    setQrCode('');
    void client.create(sessionId).then(async (next) => {
      const url = new URL(next.path, window.location.origin).toString();
      const svg = await QRCode.toString(url, { type: 'svg', width: 220, margin: 1, color: { dark: '#172018', light: '#ffffff' } });
      if (!active) return;
      setLink(next);
      setQrCode(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      setMessage('');
    }).catch((error) => { if (active) setMessage(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [client, expanded, link?.sessionId, sessionId]);

  const copyLink = async () => {
    if (!linkUrl) return;
    try {
      await navigator.clipboard.writeText(linkUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch { setMessage('复制失败，请直接打开主播屏'); }
  };

  return <details className="v2-display-link" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary><ChevronDown size={13} />主播屏入口</summary>
    {expanded && <div className="v2-display-link-body">
      {message && <span className="v2-display-link-message">{message}</span>}
      {link && <>
        <div className="v2-display-link-heading"><QrCode size={17} /><div><strong>临时入口 {link.alias}</strong><small>{new Date(link.expiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })} 前有效</small></div></div>
        {qrCode && <img src={qrCode} alt="主播屏二维码" />}
        <code>{linkUrl}</code>
        <div className="v2-display-link-actions">
          <button type="button" title="复制主播屏地址" onClick={() => void copyLink()}><Copy size={14} /><span>{copied ? '已复制' : '复制'}</span></button>
          <a href={linkUrl} target="_blank" rel="noreferrer" title="在新窗口打开主播屏"><ExternalLink size={14} /><span>打开</span></a>
        </div>
      </>}
    </div>}
  </details>;
}

function blankProduct(): Product {
  return {
    id: `product-${Date.now().toString(36)}`,
    name: '',
    category: '其他',
    price: '¥0',
    stock: null,
    sku: `SKU-${Date.now().toString(36).toUpperCase()}`,
    description: '',
    sellingPoints: [],
    image: '/products/serum.svg',
    accent: '#8da57d',
    compliantPhrases: [],
    source: 'manual',
    updatedAt: Date.now(),
  };
}

function ProductCatalogEditor({ roomId, activeProductId, products, onSaved }: { roomId: string; activeProductId: string; products: Product[]; onSaved?: (product: Product, isNew: boolean) => void }) {
  const client = useMemo(() => new CatalogClient(), []);
  const [items, setItems] = useState(products);
  const [draft, setDraft] = useState<Product | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setItems(await client.products(roomId)); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [client, roomId]);
  useEffect(() => { setItems(products); }, [products]);
  useEffect(() => {
    setDraft((current) => {
      if (!current || current.complianceProfile?.source === 'manual') return current;
      const updated = products.find((product) => product.id === current.id);
      return updated && updated.updatedAt > current.updatedAt ? { ...current, category: updated.category, complianceProfile: updated.complianceProfile, updatedAt: updated.updatedAt } : current;
    });
  }, [products]);
  useEffect(() => { void load(); }, [load]);

  const updateDraft = <K extends keyof Product>(key: K, value: Product[K]) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const updateCategory = (value: string) => setDraft((current) => current ? { ...current, category: value, ...(current.complianceProfile ? { complianceProfile: { ...current.complianceProfile, category: value, source: 'manual', status: 'verified', updatedAt: Date.now() } } : {}) } : current);
  const updateComplianceProfile = (key: 'platformRuleset' | 'industry' | 'complianceSummary' | 'riskKeywords' | 'riskBoundaries' | 'requiredDisclosures' | 'safeSellingPoints', value: string | string[]) => setDraft((current) => {
    if (!current?.complianceProfile) return current;
    const profile = { ...current.complianceProfile, [key]: value, source: 'manual' as const, status: 'verified' as const, updatedAt: Date.now() };
    return { ...current, complianceProfile: profile };
  });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    setBusy(true); setMessage('');
    try {
      const isNew = !items.some((product) => product.id === draft.id);
      const saved = await client.saveProduct(roomId, { ...draft, updatedAt: Date.now() });
      setItems((current) => current.some((product) => product.id === saved.id) ? current.map((product) => product.id === saved.id ? saved : product) : [...current, saved]);
      onSaved?.(saved, isNew);
      setDraft(saved);
      setMessage(saved.complianceProfile?.source === 'doubao' ? '商品资料已同步，豆包已生成行业、类目和合规画像' : saved.complianceProfile ? '商品已保存，本地画像立即生效；豆包将在后台补充识别' : '商品资料已同步到当前直播间和本场页面');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const remove = async (product: Product) => {
    if (typeof window.confirm === 'function' && !window.confirm(`确定从当前直播间移除“${product.name}”吗？`)) return;
    setBusy(true); setMessage('');
    try { setItems(await client.removeProduct(roomId, product.id)); if (draft?.id === product.id) setDraft(null); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const generateProfile = async () => {
    if (!draft || !items.some((product) => product.id === draft.id)) return;
    setBusy(true); setMessage('豆包正在重新识别行业、类目和合规边界');
    try {
      await client.saveProduct(roomId, { ...draft, updatedAt: Date.now() });
      const saved = await client.generateProductComplianceProfile(roomId, draft.id);
      setDraft(saved); setItems((current) => current.map((product) => product.id === saved.id ? saved : product)); onSaved?.(saved, false);
      setMessage(saved.complianceProfile?.source === 'doubao' ? '豆包识别完成，请确认后可继续自定义修改' : '豆包暂时不可用，已生成本地兜底画像，请人工复核');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const confirmProfile = async () => {
    if (!draft?.complianceProfile) return;
    setBusy(true); setMessage('');
    try {
      const confirmed = { ...draft, complianceProfile: { ...draft.complianceProfile, source: 'manual' as const, status: 'verified' as const, updatedAt: Date.now() }, updatedAt: Date.now() };
      const saved = await client.saveProduct(roomId, confirmed);
      setDraft(saved); setItems((current) => current.map((product) => product.id === saved.id ? saved : product)); onSaved?.(saved, false);
      setMessage('商品合规画像已人工确认，并同步到本场拦截条件');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };

  return <div className="v2-product-manager">
    <section className="v2-product-catalog">
      <header><div><strong>当前直播间商品</strong><small>{items.length} 个 · 修改后实时同步本场</small></div><button type="button" className="v2-add-product" onClick={() => setDraft(blankProduct())}><Plus size={13} />新增商品</button></header>
      <div>{items.map((product) => <article className={product.id === activeProductId ? 'active' : ''} key={product.id}><img src={product.image} alt="" /><div><strong>{product.name}</strong><small>{product.complianceProfile?.industry ?? '行业待识别'} · {product.category} · {product.price}</small><p>{product.complianceProfile?.complianceSummary ?? product.description}</p></div><div className="v2-product-actions"><button type="button" aria-label={`编辑 ${product.name}`} onClick={() => setDraft(structuredClone(product))}><Pencil size={13} /></button><button type="button" aria-label={`移除 ${product.name}`} disabled={busy || items.length <= 1} onClick={() => void remove(product)}><Trash2 size={13} /></button></div></article>)}</div>
    </section>
    <section className="v2-product-editor-panel">
      {draft ? <form onSubmit={(event) => void save(event)}>
        <header><div><strong>{items.some((product) => product.id === draft.id) ? '编辑商品资料' : '新增直播间商品'}</strong><small>{draft.id}</small></div><button type="button" aria-label="关闭商品编辑" onClick={() => setDraft(null)}><X size={14} /></button></header>
        <div className="v2-product-fields"><label>商品名称<input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} required /></label><label>标准类目<input value={draft.category} onChange={(event) => updateCategory(event.target.value)} required /></label><label>实时价格<input value={draft.price} onChange={(event) => updateDraft('price', event.target.value)} required /></label><label>商品编码<input value={draft.sku} onChange={(event) => updateDraft('sku', event.target.value)} required /></label></div>
        <label>商品描述<textarea value={draft.description} onChange={(event) => updateDraft('description', event.target.value)} placeholder="可稍后补充" /></label>
        <label>核心卖点<textarea value={draft.sellingPoints.join('\n')} onChange={(event) => updateDraft('sellingPoints', event.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} placeholder="每行一个卖点，可稍后补充" /></label>
        <label>对应商品参考话术<textarea value={draft.compliantPhrases.join('\n')} onChange={(event) => updateDraft('compliantPhrases', event.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} placeholder="每行一段，可稍后补充" /></label>
        {draft.complianceProfile && <label>适用平台<select value={draft.complianceProfile.platformRuleset} onChange={(event) => updateComplianceProfile('platformRuleset', event.target.value)}><option value="douyin-ecommerce-live">抖音带货直播间</option><option value="pinduoduo-ecommerce-live">拼多多带货直播间</option></select></label>}
        {draft.complianceProfile && <section className="v2-compliance-profile"><header><div><ShieldAlert size={14} /><span><strong>商品合规画像</strong><small>默认规则：抖音带货直播间 · {draft.complianceProfile.source === 'doubao' ? `豆包识别 ${Math.round(draft.complianceProfile.confidence * 100)}%` : draft.complianceProfile.source === 'manual' ? '人工确认' : '本地兜底待复核'}</small></span></div><div className="v2-profile-actions">{draft.complianceProfile.status !== 'verified' && <button type="button" disabled={busy} onClick={() => void confirmProfile()}><CheckCircle2 size={12} />确认画像</button>}<button type="button" disabled={busy} onClick={() => void generateProfile()}><RefreshCw size={12} />重新识别</button></div></header><label>所属行业<input value={draft.complianceProfile.industry} onChange={(event) => updateComplianceProfile('industry', event.target.value)} /></label><label>合规资料描述<textarea value={draft.complianceProfile.complianceSummary} onChange={(event) => updateComplianceProfile('complianceSummary', event.target.value)} /></label><label>高风险词或短语<textarea value={draft.complianceProfile.riskKeywords.join('\n')} onChange={(event) => updateComplianceProfile('riskKeywords', event.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} placeholder="每行一个；人工确认后进入本地快速拦截" /></label><label>语义风险边界<textarea value={draft.complianceProfile.riskBoundaries.join('\n')} onChange={(event) => updateComplianceProfile('riskBoundaries', event.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} placeholder="每行一条，供豆包结合上下文判断" /></label><label>必要披露与资质<textarea value={draft.complianceProfile.requiredDisclosures.join('\n')} onChange={(event) => updateComplianceProfile('requiredDisclosures', event.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} /></label><label>合规介绍方向<textarea value={draft.complianceProfile.safeSellingPoints.join('\n')} onChange={(event) => updateComplianceProfile('safeSellingPoints', event.target.value.split('\n').map((item) => item.trim()).filter(Boolean))} /></label></section>}
        {!draft.complianceProfile && items.some((product) => product.id === draft.id) && <button className="v2-profile-generate" type="button" disabled={busy} onClick={() => void generateProfile()}><Sparkles size={13} />生成商品合规画像</button>}
        <button type="submit" disabled={busy || !draft.name.trim() || !draft.category.trim() || !draft.price.trim() || !draft.sku.trim()}><Save size={13} />保存并同步本场</button>
      </form> : <div className="v2-product-editor-empty"><Package size={24} /><strong>选择商品开始调整</strong><span>开播中修改会同步到中控台、主播屏和本场历史</span></div>}
    </section>
    {message && <div className="v2-product-message">{message}</div>}
  </div>;
}

function LibraryWorkspace({ snapshot, products, send, onClose, initialTab = 'phrases', findings = [], onConfirmFinding, onDismissFinding }: { snapshot: LiveSessionSnapshot; products: Product[]; send: (command: LiveCommand) => boolean; onClose: () => void; initialTab?: 'products' | 'rules' | 'phrases'; findings?: ComplianceFinding[]; onConfirmFinding?: (finding: ComplianceFinding) => Promise<void>; onDismissFinding?: (finding: ComplianceFinding) => Promise<void> }) {
  const client = useMemo(() => new CatalogClient(), []);
  const [tab, setTab] = useState<'products' | 'rules' | 'phrases'>(initialTab);
  const [rules, setRules] = useState<ComplianceRule[]>([]);
  const [semanticUnits, setSemanticUnits] = useState<RuleUnit[]>([]);
  const [activeSemanticUnits, setActiveSemanticUnits] = useState<RuleUnit[]>([]);
  const [presenters, setPresenters] = useState<PresenterProfile[]>([]);
  const [presenterId, setPresenterId] = useState(snapshot.presenterId);
  const [phrases, setPhrases] = useState<PresenterPhrase[]>([]);
  const [findingHistory, setFindingHistory] = useState<ComplianceFinding[]>([]);
  const [syncJobs, setSyncJobs] = useState<ManualSyncJob[]>([]);
  const [syncTargets, setSyncTargets] = useState({ merchant_database: false, private_knowledge_base: false });
  const [ruleDraft, setRuleDraft] = useState<{ pattern: string; title: string; alternative: string; scope: 'room' | 'category' | 'product' }>({ pattern: '', title: '', alternative: '', scope: 'product' });
  const [phraseDraft, setPhraseDraft] = useState('');
  const [purpose, setPurpose] = useState<CoachPurpose>('塑品');
  const [newPresenter, setNewPresenter] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ruleData, presenterData, findingData] = await Promise.all([
        client.rules(snapshot.roomId),
        client.presenters(snapshot.roomId),
        client.complianceFindings(snapshot.roomId, 'all').catch(() => []),
      ]);
      setRules(ruleData.rules); setPresenters(presenterData);
      setSemanticUnits(await client.roomRuleUnits(snapshot.roomId, 'pending_review').catch(() => []));
      setActiveSemanticUnits(await client.roomRuleUnits(snapshot.roomId, 'active').catch(() => []));
      setSyncJobs(await client.syncJobs(snapshot.roomId).catch(() => []));
      setFindingHistory(Array.isArray(findingData) ? findingData.filter((finding) => finding.disposition !== 'pending') : []);
      const selected = presenterData.some((presenter) => presenter.id === presenterId) ? presenterId : presenterData[0]?.id ?? '';
      setPresenterId(selected);
      setPhrases(selected ? await client.phrases(selected) : []);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [client, presenterId, snapshot.roomId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (presenterId) void client.phrases(presenterId).then(setPhrases).catch(() => undefined); }, [client, presenterId]);
  const run = async (task: () => Promise<unknown>) => { setBusy(true); setMessage(''); try { await task(); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  const addRule = () => run(async () => { await client.createRule(snapshot.roomId, { name: ruleDraft.title || ruleDraft.pattern, pattern: ruleDraft.pattern, risk: 'blocked', title: ruleDraft.title, reason: '命中当前直播间确认的高风险表达', alternative: ruleDraft.alternative, policyRef: '直播间自定义规则', scope: ruleDraft.scope, ...(ruleDraft.scope === 'product' ? { productId: snapshot.product.id } : {}), ...(ruleDraft.scope === 'category' ? { category: snapshot.product.category } : {}) }); setRuleDraft({ pattern: '', title: '', alternative: '', scope: 'product' }); });
  const addPhrase = () => run(async () => { await client.createPhrase(presenterId, { text: phraseDraft, productId: snapshot.product.id, purpose, status: 'draft' }); setPhraseDraft(''); });
  const addPresenter = () => run(async () => { const presenter = await client.createPresenter(snapshot.roomId, newPresenter); setNewPresenter(''); setPresenterId(presenter.id); });
  const selectedSyncTargets = (): Array<'merchant_database' | 'private_knowledge_base'> => ([
    ...(syncTargets.merchant_database ? ['merchant_database' as const] : []),
    ...(syncTargets.private_knowledge_base ? ['private_knowledge_base' as const] : []),
  ]);
  const syncStatus = (resourceId: string): ManualSyncJob | undefined => syncJobs.filter((job) => job.resourceId === resourceId).sort((left, right) => right.updatedAt - left.updatedAt)[0];
  const syncStatusText = (job: ManualSyncJob): string => job.approvalStatus === 'awaiting_approval' ? '等待人工确认' : job.status;
  const requireTargets = (): Array<'merchant_database' | 'private_knowledge_base'> => {
    const targets = selectedSyncTargets();
    if (targets.length === 0) throw new Error('请先选择商家数据库或私有知识库');
    return targets;
  };

  return <div className="v2-modal"><section className="v2-review-workspace v2-library-workspace">
    <header><div><BookOpen size={19} /><span><strong>资料管理</strong><small>商品、风险规则与主播专属话术均保存在本机</small></span></div><button type="button" title="关闭" onClick={onClose}><X size={17} /></button></header>
    <nav>{(['phrases', 'rules', 'products'] as const).map((item) => <button type="button" key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item === 'phrases' ? '主播话术' : item === 'rules' ? '风险规则' : '商品资料'}</button>)}</nav>
    {tab !== 'products' && <section className="v2-sync-toolbar"><strong>人工同步目标</strong><label><input type="checkbox" checked={syncTargets.merchant_database} onChange={(event) => setSyncTargets((current) => ({ ...current, merchant_database: event.target.checked }))} />商家数据库</label><label><input type="checkbox" checked={syncTargets.private_knowledge_base} onChange={(event) => setSyncTargets((current) => ({ ...current, private_knowledge_base: event.target.checked }))} />私有知识库</label><small>{syncJobs.length === 0 ? '尚未创建同步任务' : `本直播间 ${syncJobs.length} 个任务 · ${syncJobs.filter((job) => job.status === 'failed').length} 个失败`}</small>{syncJobs.filter((job) => job.status === 'failed').slice(0, 2).map((job) => <span className="failed" key={job.id}>{job.lastError ?? '同步失败'}</span>)}</section>}
    <main>{tab === 'products' && <ProductCatalogEditor roomId={snapshot.roomId} activeProductId={snapshot.product.id} products={products} onSaved={(product, isNew) => {
      if (isNew) send({ type: 'set_lineup', productIds: [...new Set([...snapshot.lineup.map((candidate) => candidate.id), product.id])] });
    }} />}
      {tab === 'rules' && <div className="v2-rule-console"><section className="v2-finding-console"><header><span>待处置风险</span><strong>{findings.length} 条</strong></header>{findings.length === 0 ? <div className="v2-empty">当前没有等待处理的风险</div> : findings.map((finding) => <article key={finding.id}><header><div><span className={finding.result.risk}>{finding.result.risk === 'blocked' ? '高风险' : '提醒'}</span><strong>{finding.result.title}</strong></div><time>{formatTime(finding.createdAt)}</time></header><blockquote>{riskEvidence(finding.result.transcript, finding.result.matchedTerms ?? [])}</blockquote><p>{finding.result.reason}</p><small>{finding.productName} · 置信度 {Math.round(finding.result.confidence * 100)}% · {finding.result.ruleKind === 'term' ? '词级' : finding.result.ruleKind === 'sentence' ? '句级' : '上下文'}</small><div className="v2-rule-actions"><button type="button" disabled={busy} onClick={() => void run(() => onConfirmFinding?.(finding) ?? Promise.resolve())}><CheckCircle2 size={12} />确认成规则</button><button type="button" disabled={busy} onClick={() => void run(() => onDismissFinding?.(finding) ?? Promise.resolve())}>标记误判</button></div></article>)}</section>{semanticUnits.length > 0 && <section className="v2-finding-console"><header><span>待审核语义规则</span><strong>{semanticUnits.length} 条</strong></header>{semanticUnits.map((unit) => <article key={unit.id}><header><div><span className={unit.risk}>{unit.kind === 'context' ? '上下文' : '句级'}</span><strong>{unit.title}</strong></div></header><blockquote>{unit.evidenceText ?? unit.instruction}</blockquote><p>{unit.reason}</p><div className="v2-rule-actions"><button type="button" disabled={busy} onClick={() => void run(() => client.reviewRuleUnit(unit, 'approved'))}>批准本地生效</button><button type="button" disabled={busy} onClick={() => void run(() => client.reviewRuleUnit(unit, 'discarded'))}>舍弃</button></div></article>)}</section>}<div className="v2-library-columns"><section><header><span>新增风险规则</span></header><select aria-label="规则作用域" value={ruleDraft.scope} onChange={(event) => setRuleDraft({ ...ruleDraft, scope: event.target.value as typeof ruleDraft.scope })}><option value="product">当前商品</option><option value="category">当前品类（{snapshot.product.category}）</option><option value="room">当前直播间全部商品</option></select><input value={ruleDraft.pattern} onChange={(event) => setRuleDraft({ ...ruleDraft, pattern: event.target.value })} placeholder="风险词或明确短语" /><input value={ruleDraft.title} onChange={(event) => setRuleDraft({ ...ruleDraft, title: event.target.value })} placeholder="提醒标题" /><textarea value={ruleDraft.alternative} onChange={(event) => setRuleDraft({ ...ruleDraft, alternative: event.target.value })} placeholder="主播可直接替换的安全表达" /><button type="button" disabled={busy || !ruleDraft.pattern || !ruleDraft.title || !ruleDraft.alternative} onClick={addRule}><Plus size={13} />保存规则</button></section><section className="v2-library-list">{rules.map((rule) => { const scopeText = rule.scope === 'product' ? `商品 · ${rule.productId === snapshot.product.id ? '当前商品' : rule.productId ?? '未绑定'}` : rule.scope === 'category' ? `品类 · ${rule.category ?? '未绑定'}` : '直播间通用'; const latestSync = syncStatus(rule.id); return <article key={rule.id}><div><span className={rule.risk}>{rule.risk === 'blocked' ? '高风险' : '提醒'}</span><strong>{rule.name}</strong></div><p>{rule.pattern}</p><small>{scopeText} · {rule.origin === 'learned' ? `自动发现 · 证据 ${rule.evidenceCount ?? 1} 次` : rule.origin === 'confirmed' ? '主播确认' : '人工规则'} · v{rule.version} · {rule.status === 'pending_review' ? '待审核' : rule.status === 'rejected' ? '已驳回' : rule.enabled ? '已启用' : '已停用'} · 公共库：{rule.publicStatus === 'pending' ? '运营审核中' : rule.publicStatus === 'adopted' ? '已采纳' : rule.publicStatus === 'deferred' ? '待定' : rule.publicStatus === 'discarded' ? '已舍弃' : '未提交'}{latestSync ? ` · 同步：${syncStatusText(latestSync)}` : ''}</small><div className="v2-rule-actions">{rule.status === 'pending_review' ? <><button type="button" disabled={busy} onClick={() => void run(() => client.reviewRule(rule, 'approved'))}>批准启用</button><button type="button" disabled={busy} onClick={() => void run(() => client.reviewRule(rule, 'rejected'))}>驳回</button></> : rule.status === 'rejected' ? <button type="button" disabled={busy} onClick={() => void run(() => client.reviewRule(rule, 'approved'))}>重新批准</button> : <><button type="button" disabled={busy} onClick={() => void run(() => client.setRuleEnabled(rule, !rule.enabled))}>{rule.enabled ? '停用' : '启用'}</button>{rule.publicStatus !== 'pending' && rule.publicStatus !== 'adopted' && <button type="button" disabled={busy} onClick={() => void run(() => client.submitRuleToPublic(rule))}>提交运营审核</button>}<button type="button" disabled={busy || !rule.enabled} onClick={() => void run(() => client.syncRule(rule, requireTargets()))}><Database size={12} />人工同步</button></>}{rule.version > 1 && <button type="button" disabled={busy} onClick={() => void run(() => client.rollbackRule(rule, rule.version - 1))}>回滚上一版</button>}</div></article>; })}</section></div>{findingHistory.length > 0 && <details className="v2-finding-history"><summary>已处置记录 {findingHistory.length}</summary><div>{findingHistory.slice(0, 20).map((finding) => <article key={finding.id}><span className={finding.disposition}>{finding.disposition === 'confirmed' ? '已转规则' : '已标记误判'}</span><p>{finding.result.transcript}</p><small>{finding.productName} · {formatTime(finding.disposedAt ?? finding.updatedAt)}{finding.resolutionNote ? ` · ${finding.resolutionNote}` : ''}</small></article>)}</div></details>}</div>}
      {tab === 'phrases' && <div className="v2-library-columns"><section><header><span>主播档案</span></header><select value={presenterId} onChange={(event) => setPresenterId(event.target.value)}>{presenters.map((presenter) => <option value={presenter.id} key={presenter.id}>{presenter.name}</option>)}</select><button type="button" disabled={!presenterId || presenterId === snapshot.presenterId} onClick={() => send({ type: 'select_presenter', presenterId })}><UserRound size={13} />{presenterId === snapshot.presenterId ? '本场当前主播' : '设为本场主播'}</button><div className="v2-inline-form"><input value={newPresenter} onChange={(event) => setNewPresenter(event.target.value)} placeholder="新增主播名称" /><button type="button" disabled={!newPresenter.trim() || busy} onClick={addPresenter}><Plus size={13} /></button></div><select value={purpose} onChange={(event) => setPurpose(event.target.value as CoachPurpose)}><option>塑品</option><option>憋单</option><option>逼单</option><option>转化</option><option>互动</option><option>留人</option><option>答疑</option></select><textarea value={phraseDraft} onChange={(event) => setPhraseDraft(event.target.value)} placeholder="录入头部直播间话术，或保存下一场参考表达" /><button type="button" disabled={busy || !presenterId || !phraseDraft.trim()} onClick={addPhrase}><Save size={13} />保存话术</button></section><section className="v2-library-list">{phrases.map((phrase) => { const latestSync = syncStatus(phrase.id); return <article key={phrase.id}><div><span className={phrase.status}>{phrase.status === 'reference' ? '下一场参考' : phrase.source === 'session' ? '下播归档' : '草稿'}</span><strong>{phrase.purpose ?? '通用'}</strong></div><p>{phrase.text}</p><small>{phrase.source === 'session' ? '来自历史直播' : phrase.source === 'manual' ? '人工录入' : '豆包改写'} · v{phrase.version}{latestSync ? ` · 同步：${latestSync.status}` : ''}</small><div className="v2-rule-actions"><button type="button" onClick={() => void run(() => client.updatePhrase(phrase.id, { status: phrase.status === 'reference' ? 'draft' : 'reference' }))}>{phrase.status === 'reference' ? '取消参考' : '选为参考'}</button><button type="button" disabled={busy} onClick={() => void run(() => client.syncPhrase(phrase, requireTargets()))}><Database size={12} />人工同步</button></div></article>; })}</section></div>}
      {tab === 'rules' && activeSemanticUnits.length > 0 && <section className="v2-finding-console"><header><span>已生效语义规则</span><strong>{activeSemanticUnits.length} 条</strong></header>{activeSemanticUnits.map((unit) => { const latestSync = syncStatus(unit.id); return <article key={unit.id}><header><div><span className={unit.risk}>{unit.kind === 'context' ? '上下文' : '句级'}</span><strong>{unit.title}</strong></div></header><blockquote>{unit.evidenceText ?? unit.instruction}</blockquote><small>公共库：{unit.publicStatus === 'pending' ? '运营审核中' : unit.publicStatus === 'adopted' ? '已采纳' : unit.publicStatus === 'deferred' ? '待定' : unit.publicStatus === 'discarded' ? '已舍弃' : '未提交'}{latestSync ? ` · 同步：${latestSync.status}` : ''}</small><div className="v2-rule-actions">{unit.publicStatus !== 'pending' && unit.publicStatus !== 'adopted' && <button type="button" disabled={busy} onClick={() => void run(() => client.submitRuleUnitToPublic(unit))}>提交运营审核</button>}<button type="button" disabled={busy} onClick={() => void run(() => client.syncRuleUnit(unit, requireTargets()))}><Database size={12} />人工同步</button></div></article>; })}</section>}
    </main>{message && <div className="v2-review-message">{message}</div>}
  </section></div>;
}

function ReviewWorkspace({ roomId, onClose }: { roomId: string; onClose: () => void }) {
  const client = useMemo(() => new SessionReviewClient(), []);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [review, setReview] = useState<SessionReview | null>(null);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<{ segmentId: string; text: string } | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      const items = await client.listSessions(roomId);
      setSessions(items);
      setSelected((current) => current || items[0]?.sessionId || '');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [client, roomId]);
  const loadReview = useCallback(async (sessionId: string) => {
    if (!sessionId) { setReview(null); return; }
    try { const next = await client.getReview(sessionId); setReview(next); setNote(next.summary.note); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [client]);
  useEffect(() => { void loadSessions(); }, [loadSessions]);
  useEffect(() => { void loadReview(selected); }, [loadReview, selected]);

  const run = async (task: () => Promise<unknown>) => {
    setBusy(true); setMessage('');
    try { await task(); await loadSessions(); await loadReview(selected); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const saveTranscript = () => editing && run(() => client.correctTranscript(selected, editing.segmentId, editing.text).then(() => setEditing(null)));
  const assignSpeaker = (segment: TranscriptSegment) => run(() => client.assignSpeaker(selected, segment.id, segment.speaker === 'other' ? 'host' : 'other', segment.speakerId));
  const saveNote = () => run(() => client.saveNote(selected, note));
  const deliver = () => run(() => review?.delivery === 'failed' ? client.retryDelivery(selected) : client.approveDelivery(selected));

  return <div className="v2-modal"><section className="v2-review-workspace">
    <header><div><Archive size={19} /><span><strong>历史复核</strong><small>修改后重新人工确认，才会进入知识库和数据库上传队列</small></span></div><button type="button" title="关闭" onClick={onClose}><X size={17} /></button></header>
    <div className="v2-review-layout"><aside><div className="v2-review-sidehead"><span>{sessions.length} 场直播</span><button type="button" title="刷新" onClick={() => void loadSessions()}><RefreshCw size={13} /></button></div>{sessions.map((session) => <button type="button" className={selected === session.sessionId ? 'active' : ''} key={session.sessionId} onClick={() => setSelected(session.sessionId)}><strong>{new Date(session.createdAt).toLocaleString('zh-CN', { hour12: false })}</strong><small>{session.presenterName} · {session.transcriptCount} 段</small><span className={session.delivery}>{session.delivery === 'synced' ? '已上传' : session.approval === 'approved' ? '已确认' : '待确认'}</span></button>)}</aside>
      <main>{review ? <>
        <div className="v2-review-summary"><div><strong>{review.summary.presenterName}</strong><span>内容版本 {review.summary.contentRevision}</span></div><div><span className={`v2-delivery ${review.delivery}`}>{review.delivery === 'synced' ? '已同步' : review.delivery === 'failed' ? '上传失败' : review.approval === 'approved' ? '已人工确认' : '等待人工确认'}</span><button type="button" onClick={deliver} disabled={busy || review.summary.lifecycle !== 'ended' || note !== review.summary.note}><Database size={14} />{review.delivery === 'failed' ? '重新上传' : '确认并上传'}</button></div></div>
        <div className="v2-review-note"><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="记录本场表现、待改话术和下一场安排" /><button type="button" disabled={busy || note === review.summary.note} onClick={saveNote}><Save size={13} />保存备注</button></div>
        {review.audioPath && <SessionAudio client={client} sessionId={selected} />}
        <section className="v2-review-transcripts"><header><span>转录与说话人</span><small>主播 / 其他人可逐段纠正</small></header>{review.transcripts.map((segment) => <article key={segment.id}><time>{formatTime(segment.timestamp)}</time><button type="button" className="v2-speaker-button" onClick={() => void assignSpeaker(segment)} disabled={busy}><SpeakerBadge segment={segment} /></button>{editing?.segmentId === segment.id ? <div className="v2-review-edit"><textarea value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.target.value })} /><button type="button" onClick={() => void saveTranscript()} disabled={busy}><Save size={13} /></button><button type="button" onClick={() => setEditing(null)}><X size={13} /></button></div> : <><p>{segment.text}</p><button type="button" title="纠正文本" onClick={() => setEditing({ segmentId: segment.id, text: segment.text })}><Pencil size={13} /></button></>}</article>)}</section>
      </> : <div className="v2-empty">选择一场直播开始复核</div>}</main></div>
    {message && <div className="v2-review-message">{message}</div>}
  </section></div>;
}

function SessionAudio({ client, sessionId }: { client: SessionReviewClient; sessionId: string }) {
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setSrc('');
    setError('');
    void client.loadAudioUrl(sessionId).then((url) => {
      objectUrl = url;
      if (active) setSrc(url); else URL.revokeObjectURL(url);
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, sessionId]);
  if (error) return <div className="v2-review-message">{error}</div>;
  return src ? <audio controls preload="metadata" src={src} /> : <div className="v2-empty">正在读取本地音频</div>;
}

function OperationsApp() {
  const client = useMemo(() => new CatalogClient(), []);
  const [rules, setRules] = useState<ComplianceRule[]>([]);
  const [documents, setDocuments] = useState<RuleDocument[]>([]);
  const [units, setUnits] = useState<RuleUnit[]>([]);
  const [publicUnits, setPublicUnits] = useState<RuleUnit[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [nextRules, nextDocuments, packageState, nextPublicUnits] = await Promise.all([client.publicRuleCandidates(), client.ruleDocuments(), client.rulePackages(), client.publicRuleUnitCandidates()]);
      setRules(Array.isArray(nextRules) ? nextRules : []);
      setDocuments(Array.isArray(nextDocuments) ? nextDocuments : []);
      setUnits(Array.isArray(packageState?.units) ? packageState.units : []);
      setPublicUnits(Array.isArray(nextPublicUnits) ? nextPublicUnits.filter((unit): unit is RuleUnit => Boolean(unit && typeof unit === 'object' && typeof unit.packageId === 'string' && (unit.kind === 'term' || unit.kind === 'sentence' || unit.kind === 'context'))) : []);
    }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, [client]);
  useEffect(() => { void load(); }, [load]);
  const review = async (rule: ComplianceRule, decision: 'adopted' | 'deferred' | 'discarded') => {
    setBusy(true); setMessage('');
    try { await client.reviewPublicRule(rule, decision); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const reviewUnit = async (unit: RuleUnit, decision: 'approved' | 'rejected' | 'deferred' | 'discarded') => {
    setBusy(true); setMessage('');
    try { await client.reviewRuleUnit(unit, decision); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const reviewPublicUnit = async (unit: RuleUnit, decision: 'adopted' | 'deferred' | 'discarded') => {
    setBusy(true); setMessage('');
    try { await client.reviewPublicRuleUnit(unit, decision); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const reviewDocument = async (document: RuleDocument, decision: 'approved' | 'rejected') => {
    setBusy(true); setMessage('');
    try { await client.reviewRuleDocument(document, decision); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const statusText = (status: ComplianceRule['publicStatus']) => ({ pending: '待运营审核', adopted: '已采纳', deferred: '待定', discarded: '已舍弃', not_submitted: '未提交' }[status ?? 'not_submitted']);
  return <div className="v2-app v2-operations-app"><section className="v2-review-workspace v2-operations-workspace">
    <header><div><ShieldAlert size={19} /><span><strong>服务运营审核</strong><small>只有采纳的规则会进入公共规则库；待定和舍弃不会影响原直播间</small></span></div><a href="/">返回直播中控</a></header>
    <main>
      <section className="v2-operations-summary"><span>规则文档 {documents.length}</span><span>待审核规则单元 {units.filter((unit) => unit.status === 'pending_review').length}</span><span>公共规则候选 {rules.length + publicUnits.length}</span></section>
      {documents.filter((document) => document.status === 'pending_review').map((document) => <article className="v2-operations-card" key={document.id}><header><div><span className="warning">文档更新</span><strong>{document.title}</strong></div><small>版本 {document.latestVersion} · {document.publisher}</small></header><p>该官方文档有新版本，审核规则单元后才会进入可执行规则包。</p><div className="v2-operations-actions"><button type="button" disabled={busy} onClick={() => void reviewDocument(document, 'approved')}><CheckCircle2 size={13} />通过文档</button><button type="button" disabled={busy} onClick={() => void reviewDocument(document, 'rejected')}><Trash2 size={13} />驳回文档</button></div></article>)}
      {units.filter((unit) => unit.status === 'pending_review').map((unit) => <article className="v2-operations-card" key={unit.id}><header><div><span className={unit.risk}>{unit.risk === 'blocked' ? '高风险' : '需注意'}</span><strong>{unit.title}</strong></div><small>{unit.kind === 'context' ? '上下文规则' : unit.kind === 'sentence' ? '句级规则' : '词级规则'}</small></header><blockquote>{riskEvidence(unit.evidenceText ?? unit.pattern ?? unit.instruction ?? '', unit.matchedTerms ?? [])}</blockquote><p>{unit.reason}</p><div className="v2-operations-actions"><button type="button" disabled={busy} onClick={() => void reviewUnit(unit, 'approved')}><CheckCircle2 size={13} />本地激活</button><button type="button" disabled={busy} onClick={() => void reviewUnit(unit, 'deferred')}>待定</button><button type="button" disabled={busy} onClick={() => void reviewUnit(unit, 'discarded')}><Trash2 size={13} />舍弃</button></div></article>)}
      {publicUnits.map((unit) => <article className="v2-operations-card" key={unit.id}><header><div><span className={unit.risk}>{unit.risk === 'blocked' ? '高风险' : '需注意'}</span><strong>{unit.title}</strong></div><small>商家提交 · {unit.kind === 'context' ? '上下文规则' : unit.kind === 'sentence' ? '句级规则' : '词级规则'}</small></header><blockquote>{riskEvidence(unit.evidenceText ?? unit.pattern ?? unit.instruction ?? '', unit.matchedTerms ?? [])}</blockquote><p>{unit.reason}</p><div className="v2-operations-meta"><span>置信度：{Math.round(unit.confidence * 100)}%</span><span>依据：{unit.policyRef}</span></div><div className="v2-operations-actions"><button type="button" disabled={busy} onClick={() => void reviewPublicUnit(unit, 'adopted')}><CheckCircle2 size={13} />采纳并进入公共库</button><button type="button" disabled={busy} onClick={() => void reviewPublicUnit(unit, 'deferred')}>待定</button><button type="button" disabled={busy} onClick={() => void reviewPublicUnit(unit, 'discarded')}><Trash2 size={13} />舍弃</button></div></article>)}
      {rules.length === 0 ? <div className="v2-empty">暂无已提交的直播间规则</div> : <div className="v2-operations-list">{rules.map((rule) => <article key={rule.id}>
      <header><div><span className={rule.risk}>{rule.risk === 'blocked' ? '高风险' : '需注意'}</span><strong>{rule.name}</strong></div><small>{statusText(rule.publicStatus)}</small></header>
      <blockquote>{riskEvidence(rule.evidenceText ?? rule.pattern, rule.matchedTerms ?? [rule.pattern])}</blockquote>
      <p>{rule.reason}</p>
      <div className="v2-operations-meta"><span>来源直播间：{rule.roomId}</span><span>置信度：{Math.round((rule.confidence ?? 0) * 100)}%</span><span>证据：{rule.evidenceCount ?? 1} 次</span><span>品类：{rule.category ?? '通用'}</span></div>
      {rule.publicStatus === 'pending' && <div className="v2-operations-actions"><button type="button" disabled={busy} onClick={() => void review(rule, 'adopted')}><CheckCircle2 size={13} />采纳并进入公共库</button><button type="button" disabled={busy} onClick={() => void review(rule, 'deferred')}>待定</button><button type="button" disabled={busy} onClick={() => void review(rule, 'discarded')}><Trash2 size={13} />舍弃</button></div>}
    </article>)}</div>}
    </main>
    {message && <div className="v2-review-message">{message}</div>}
  </section></div>;
}

function OperatorApp() {
  const live = useLive('operator');
  const catalog = useMemo(() => new CatalogClient(), []);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [libraryTab, setLibraryTab] = useState<'products' | 'rules' | 'phrases'>('phrases');
  const [findings, setFindings] = useState<ComplianceFinding[]>([]);
  const findingsRequest = useRef(0);
  const loadFindings = useCallback(async () => {
    const requestSequence = ++findingsRequest.current;
    const next = await catalog.complianceFindings(live.snapshot.roomId);
    if (requestSequence === findingsRequest.current) setFindings(Array.isArray(next) ? next : []);
  }, [catalog, live.snapshot.roomId]);
  useEffect(() => { void loadFindings().catch(() => undefined); }, [loadFindings, live.snapshot.latestCompliance?.id]);
  const confirmFinding = async (finding: ComplianceFinding) => {
    await catalog.confirmComplianceFinding(finding);
    setFindings((current) => current.filter((candidate) => candidate.id !== finding.id));
    await loadFindings();
  };
  const dismissFinding = async (finding: ComplianceFinding) => {
    await catalog.dismissComplianceFinding(finding);
    setFindings((current) => current.filter((candidate) => candidate.id !== finding.id));
    await loadFindings();
  };
  const openLibrary = (tab: 'products' | 'rules' | 'phrases' = 'phrases') => { setLibraryTab(tab); setLibraryOpen(true); };
  return <div className="v2-app">
    <header className="v2-topbar"><div className="v2-brand"><span><MonitorUp size={18} /></span><div><strong>直播中控</strong><small>风险预警与主播提词</small></div></div><div className="v2-live-state"><i className={live.snapshot.lifecycle === 'live' ? 'live' : ''} /><span>{lifecycleText(live.snapshot.lifecycle)}</span><small>{live.snapshot.presenterName}</small></div><LiveControls snapshot={live.snapshot} connected={live.connected} status={live.status} send={live.send} sendAudio={live.sendAudio} /></header>
    <div className="v2-operator-grid"><ProductRail snapshot={live.snapshot} products={live.products} send={live.send} openHistory={() => setHistoryOpen(true)} openLibrary={() => openLibrary()} />
      <main className="v2-main"><header className="v2-product-context"><div><span>当前商品</span><h1>{live.snapshot.product.name}</h1></div><strong>{live.snapshot.product.price}</strong></header><CoachBoard snapshot={live.snapshot} /><TranscriptFeed snapshot={live.snapshot} compact /><DemoInput snapshot={live.snapshot} send={live.send} /></main>
      <aside className="v2-right-rail"><RiskPanel snapshot={live.snapshot} findings={findings} onConfirmFinding={confirmFinding} onDismissFinding={dismissFinding} onOpenInbox={() => openLibrary('rules')} /><section className="v2-session-stats"><div><Clock3 size={14} /><span>直播时长</span><strong>{Math.floor(live.snapshot.stats.speakingSeconds / 60).toString().padStart(2, '0')}:{(live.snapshot.stats.speakingSeconds % 60).toString().padStart(2, '0')}</strong></div><div><AlertTriangle size={14} /><span>风险提醒</span><strong>{live.snapshot.stats.warningCount + live.snapshot.stats.blockedCount}</strong></div></section><DisplayLinkPanel sessionId={live.snapshot.sessionId} /></aside>
    </div>{historyOpen && <ReviewWorkspace roomId={live.snapshot.roomId} onClose={() => setHistoryOpen(false)} />}{libraryOpen && <LibraryWorkspace snapshot={live.snapshot} products={live.products} send={live.send} onClose={() => setLibraryOpen(false)} initialTab={libraryTab} findings={findings} onConfirmFinding={confirmFinding} onDismissFinding={dismissFinding} />}
  </div>;
}

function DisplayApp() {
  const live = useLive('display');
  const currentTranscript = live.snapshot.partialTranscript || live.snapshot.transcriptHistory.at(-1)?.text || '等待主播开始说话';
  return <div className="v2-display"><header><div className="v2-brand"><span><MonitorUp size={18} /></span><div><strong>主播提示屏</strong><small>{live.snapshot.product.name}</small></div></div><div className="v2-live-state"><i className={live.snapshot.lifecycle === 'live' ? 'live' : ''} /><span>{lifecycleText(live.snapshot.lifecycle)}</span></div></header><main><section className="v2-display-transcript"><header><span>流式话术转录</span><SpeakerBadge segment={live.snapshot.transcriptHistory.at(-1) ?? { id: 'partial', text: '', isFinal: false, timestamp: Date.now(), offsetMs: null, startOffsetMs: null, endOffsetMs: null, speaker: 'host' }} /></header><p>{currentTranscript}</p></section><CoachBoard snapshot={live.snapshot} display /><RiskPanel snapshot={live.snapshot} display /></main><footer><span>{live.status}</span><strong>{live.snapshot.product.name} · {live.snapshot.product.price}</strong></footer></div>;
}

function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const client = useMemo(() => new AuthClient(), []);
  const [actorId, setActorId] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setMessage('');
    try { await client.login(actorId, password); onLoggedIn(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  };
  return <main className="v2-login"><form onSubmit={(event) => void submit(event)}><div className="v2-brand"><span><MonitorUp size={20} /></span><div><strong>直播中控</strong><small>多人协作模式</small></div></div><h1>登录直播中控</h1><label>账号<input autoFocus autoComplete="username" value={actorId} onChange={(event) => setActorId(event.target.value)} /></label><label>密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>{message && <p>{message}</p>}<button className="primary" type="submit" disabled={busy || !actorId.trim() || !password}>{busy ? '正在登录' : '登录'}</button></form></main>;
}

function AuthGate({ children }: { children: ReactNode }) {
  const [loginRequired, setLoginRequired] = useState(false);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const requireLogin = () => setLoginRequired(true);
    window.addEventListener(V2_AUTH_REQUIRED_EVENT, requireLogin);
    return () => window.removeEventListener(V2_AUTH_REQUIRED_EVENT, requireLogin);
  }, []);
  if (loginRequired) return <LoginScreen onLoggedIn={() => { setLoginRequired(false); setGeneration((value) => value + 1); }} />;
  return <div key={generation}>{children}</div>;
}

export default function App() {
  if (window.location.pathname.startsWith('/screen/')) return <DisplayApp />;
  if (window.location.pathname.startsWith('/operations')) return <AuthGate><OperationsApp /></AuthGate>;
  return <AuthGate><OperatorApp /></AuthGate>;
}
