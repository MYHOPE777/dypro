import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  ClipboardPaste,
  Database,
  ChevronRight,
  CircleStop,
  ExternalLink,
  Headphones,
  Keyboard,
  Mic,
  Monitor,
  Pencil,
  Plus,
  Play,
  Radio,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Volume2,
  Wifi,
  XCircle,
} from 'lucide-react';
import { DEFAULT_PRODUCT } from './shared/products';
import type { ComplianceResult, ComplianceRule, LiveRoom, Product, ProductImportResponse, RuleAuditEntry, ServerMessage, SessionState } from './shared/types';

type Role = 'operator' | 'display';

const EMPTY_STATE: SessionState = {
  sessionId: '',
  roomId: 'room-default',
  product: DEFAULT_PRODUCT,
  lineup: [DEFAULT_PRODUCT],
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
  const [roomId] = useState(() => new URLSearchParams(window.location.search).get('room') ?? localStorage.getItem('live-room') ?? 'room-default');
  const [actorId] = useState(() => {
    const stored = localStorage.getItem('live-actor');
    if (stored) return stored;
    const generated = `operator-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem('live-actor', generated);
    return generated;
  });
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
        socket.send(JSON.stringify({ type: 'session.join', sessionId: sessionId || undefined, roomId, actorId, role }));
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
          setState((current) => {
            const existingIndex = current.transcriptHistory.findIndex((segment) => segment.id === message.segment.id);
            const transcriptHistory = existingIndex < 0
              ? [...current.transcriptHistory, message.segment].slice(-20)
              : current.transcriptHistory.map((segment, index) => index === existingIndex ? message.segment : segment);
            return { ...current, partialTranscript: '', transcriptHistory };
          });
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
  }, [actorId, role, roomId, sessionId]);

  const send = useCallback((message: object) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message));
  }, []);

  return { state, sessionId, roomId, actorId, connected, status, send };
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
  const displayUrl = `${lanOrigin}/display?session=${state.sessionId}&room=${state.roomId}`;
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
      <div className="product-now"><img src={state.product.image} alt="" /><div><span>ON AIR PRODUCT</span><strong>{state.product.name}</strong><small>{state.product.category} · {state.product.price}</small></div></div>
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
  created: '创建', submitted: '提交审核', approved: '审核通过', rejected: '驳回', edited: '保存新版本', rolled_back: '回滚', disabled: '停用', enabled: '启用',
};

function WorkspaceModal({ state, actorId, send, onClose }: { state: SessionState; actorId: string; send: (message: object) => void; onClose: () => void }) {
  const [tab, setTab] = useState<'products' | 'rules'>('products');
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

  const actorHeaders = { 'Content-Type': 'application/json', 'X-Actor-Id': actorId };
  const refresh = useCallback(async () => {
    const [roomsResponse, productsResponse, rulesResponse, auditsResponse] = await Promise.all([
      fetch('/api/rooms'), fetch(`/api/rooms/${state.roomId}/products`), fetch(`/api/rooms/${state.roomId}/rules`), fetch(`/api/rooms/${state.roomId}/rules/audits`),
    ]);
    if (!roomsResponse.ok || !productsResponse.ok || !rulesResponse.ok || !auditsResponse.ok) throw new Error('工作区数据读取失败');
    setRooms(await roomsResponse.json() as LiveRoom[]);
    setProducts(await productsResponse.json() as Product[]);
    setRules(await rulesResponse.json() as ComplianceRule[]);
    setAudits(await auditsResponse.json() as RuleAuditEntry[]);
  }, [state.roomId]);

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
    const body = action === 'rollback' ? { targetVersion: Math.max(1, rule.version - 1) } : {};
    const response = await fetch(`/api/rules/${rule.id}/${action}`, { method: 'POST', headers: actorHeaders, body: JSON.stringify(body) });
    const result = await response.json() as { message?: string };
    setMessage(response.ok ? '规则状态已更新' : result.message ?? '规则操作失败');
    if (response.ok) await refresh();
  };

  const currentRoom = rooms.find((room) => room.id === state.roomId);
  return <div className="modal-backdrop" role="presentation"><section className="workspace-modal" role="dialog" aria-modal="true" aria-label="直播间工作区">
    <header className="workspace-head"><div><span className="section-kicker">直播间工作区 <span>ROOM DATA</span></span><h2>{currentRoom?.name ?? '当前直播间'}</h2><p>{currentRoom?.accountName ?? state.roomId} · 负责人 {currentRoom?.ownerActorId ?? 'owner'}</p></div><div className="actor-switch"><input value={actorDraft} onChange={(event) => setActorDraft(event.target.value)} aria-label="当前操作人账号" /><button type="button" onClick={switchActor}>切换操作人</button></div><button type="button" className="modal-close" onClick={onClose} title="关闭">×</button></header>
    <div className="room-toolbar"><select value={state.roomId} onChange={(event) => switchRoom(event.target.value)} aria-label="切换直播间">{rooms.map((room) => <option key={room.id} value={room.id}>{room.name} · {room.accountName}</option>)}</select><input value={newRoomName} onChange={(event) => setNewRoomName(event.target.value)} placeholder="新直播间名称" /><input value={newAccountName} onChange={(event) => setNewAccountName(event.target.value)} placeholder="抖音账号名称" /><button type="button" onClick={() => void createRoom()}><Plus size={14} />创建</button></div>
    <div className="workspace-tabs"><button type="button" className={tab === 'products' ? 'active' : ''} onClick={() => setTab('products')}><Database size={15} />商品库</button><button type="button" className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}><ShieldCheck size={15} />规则库</button></div>
    {tab === 'products' ? <div className="workspace-grid">
      <section className="catalog-pane"><div className="pane-head"><div><strong>长期商品库</strong><span>{products.length} 件</span></div><button type="button" title="刷新" onClick={() => void refresh()}><RefreshCw size={14} /></button></div><div className="catalog-list">{products.map((product) => <label className="catalog-row" key={product.id}><input type="checkbox" checked={selectedIds.includes(product.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...new Set([...current, product.id])] : current.filter((id) => id !== product.id))} /><img src={product.image} alt="" /><span><strong>{product.name}</strong><small>{product.price} · 库存 {product.stock ?? '待确认'} · {product.sku || '无 SKU'}</small></span></label>)}</div><button type="button" className="primary-wide" disabled={selectedIds.length === 0} onClick={() => { send({ type: 'lineup.set', productIds: selectedIds }); onClose(); }}><Save size={15} />保存为本场商品清单</button></section>
      <section className="import-pane"><div className="pane-head"><div><strong>粘贴识别商品</strong><span>豆包结构化</span></div></div><textarea value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="粘贴商品标题、详情、价格、库存、SKU、卖点等文本" /><button type="button" className="secondary-wide" disabled={busy || !importText.trim()} onClick={() => void parseProduct()}><ClipboardPaste size={15} />{busy ? '识别中' : '识别商品信息'}</button>{importResult && <div className="product-draft"><div className="draft-source">{importResult.source === 'doubao' ? 'DOUBAO' : 'LOCAL'} · {Math.round(importResult.confidence * 100)}%</div><label>名称<input value={importResult.product.name} onChange={(event) => setImportResult({ ...importResult, product: { ...importResult.product, name: event.target.value } })} /></label><div className="draft-fields"><label>价格<input value={importResult.product.price} onChange={(event) => setImportResult({ ...importResult, product: { ...importResult.product, price: event.target.value } })} /></label><label>库存<input type="number" value={importResult.product.stock ?? ''} onChange={(event) => setImportResult({ ...importResult, product: { ...importResult.product, stock: event.target.value ? Number(event.target.value) : null } })} /></label></div><label>SKU<input value={importResult.product.sku} onChange={(event) => setImportResult({ ...importResult, product: { ...importResult.product, sku: event.target.value } })} /></label>{importResult.warnings.map((warning) => <p key={warning}>{warning}</p>)}<button type="button" className="primary-wide" onClick={() => void saveProduct()}><Save size={15} />保存到商品库</button></div>}</section>
    </div> : <div className="workspace-grid rules-grid">
      <section className="rule-form"><div className="pane-head"><div><strong>{editingRuleId ? '编辑规则新版本' : '新增内部规则'}</strong><span>房间规则立即生效，共享规则需审核</span></div></div><input value={ruleDraft.name} onChange={(event) => setRuleDraft({ ...ruleDraft, name: event.target.value })} placeholder="规则名称" /><div className="draft-fields"><select value={ruleDraft.scope} onChange={(event) => setRuleDraft({ ...ruleDraft, scope: event.target.value as RuleDraft['scope'] })}><option value="room">当前直播间</option><option value="shared">共享规则</option></select><select value={ruleDraft.risk} onChange={(event) => setRuleDraft({ ...ruleDraft, risk: event.target.value as RuleDraft['risk'] })}><option value="warning">需留意</option><option value="blocked">高风险</option><option value="safe">安全白名单</option></select></div><div className="draft-fields"><select value={ruleDraft.matchType} onChange={(event) => setRuleDraft({ ...ruleDraft, matchType: event.target.value as RuleDraft['matchType'] })}><option value="contains">包含关键词</option><option value="regex">正则表达式</option></select><input value={ruleDraft.pattern} onChange={(event) => setRuleDraft({ ...ruleDraft, pattern: event.target.value })} placeholder="违规词或匹配表达式" /></div><input value={ruleDraft.title} onChange={(event) => setRuleDraft({ ...ruleDraft, title: event.target.value })} placeholder="预警标题" /><textarea value={ruleDraft.reason} onChange={(event) => setRuleDraft({ ...ruleDraft, reason: event.target.value })} placeholder="违规原因" /><textarea value={ruleDraft.alternative} onChange={(event) => setRuleDraft({ ...ruleDraft, alternative: event.target.value })} placeholder="主播可立即照读的替代表达" /><button type="button" className="primary-wide" disabled={busy} onClick={() => void saveRule()}><Save size={15} />{editingRuleId ? '保存新版本' : '保存规则'}</button></section>
      <section className="catalog-pane"><div className="pane-head"><div><strong>规则与审核</strong><span>{rules.length} 条 · 日志 {audits.length} 条</span></div><button type="button" title="刷新" onClick={() => void refresh()}><RefreshCw size={14} /></button></div><div className="rule-list">{rules.map((rule) => <div className="rule-row" key={rule.id}><div><span className={`rule-status ${rule.status}`}>{RULE_STATUS_LABEL[rule.status]}</span><strong>{rule.name}</strong><small>v{rule.version} · {rule.scope === 'shared' ? '共享' : '当前直播间'} · {rule.pattern}</small></div><p>{rule.reason}</p><div className="rule-actions"><button type="button" onClick={() => { setEditingRuleId(rule.id); setRuleDraft({ name: rule.name, scope: rule.scope, matchType: rule.matchType, pattern: rule.pattern, risk: rule.risk, title: rule.title, reason: rule.reason, alternative: rule.alternative, policyRef: rule.policyRef }); }}>编辑</button>{rule.status === 'pending_review' && <><button type="button" onClick={() => void ruleAction(rule, 'approve')}>审核通过</button><button type="button" onClick={() => void ruleAction(rule, 'reject')}>驳回</button></>}{rule.version > 1 && <button type="button" onClick={() => void ruleAction(rule, 'rollback')}>回滚上一版</button>}</div></div>)}</div><div className="audit-list"><strong>最近操作日志</strong>{audits.slice(-6).reverse().map((audit) => <div key={audit.id}><span>{new Date(audit.occurredAt).toLocaleString('zh-CN', { hour12: false })}</span><em>{audit.actorId}</em><span>{RULE_ACTION_LABEL[audit.action]}</span></div>)}</div></section>
    </div>}
    {message && <div className="workspace-message">{message}</div>}
  </section></div>;
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

function TranscriptStage({ state, send }: { state: SessionState; send: (message: object) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const lastFinal = state.transcriptHistory[state.transcriptHistory.length - 1];
  return <section className="stage-section transcript-stage">
    <div className="section-heading"><div><span className="section-kicker">实时转录 <span>VOLCENGINE ASR</span></span><h1>{state.partialTranscript || lastFinal?.text || '等待主播开口'}</h1></div><div className="asr-badge"><span className="signal-dot on" />{state.isListening ? 'STREAMING' : 'STANDBY'}</div></div>
    <Waveform active={state.isListening} />
    <div className="transcript-feed">{state.transcriptHistory.slice(-4).map((segment, index) => <div className={`feed-line ${index === state.transcriptHistory.slice(-4).length - 1 ? 'current' : ''}`} key={segment.id}><time><span>{new Date(segment.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><em>{formatReplayOffset(segment.offsetMs)}</em></time>{editingId === segment.id ? <form className="transcript-edit" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) { send({ type: 'transcript.correct', segmentId: segment.id, text: draft.trim() }); setEditingId(null); } }}><input value={draft} onChange={(event) => setDraft(event.target.value)} autoFocus /><button type="submit" title="保存纠错"><Save size={13} /></button><button type="button" title="取消纠错" onClick={() => setEditingId(null)}>×</button></form> : <><span>{segment.text}</span>{segment.isFinal && <button type="button" className="transcript-edit-button" title="纠正这句转录" onClick={() => { setEditingId(segment.id); setDraft(segment.text); }}><Pencil size={12} /></button>}</>}</div>)}</div>
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
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  return <div className="app-shell operator-shell"><AppHeader state={session.state} connected={session.connected} status={session.status} mode="operator" /><main className="operator-grid"><aside className="left-rail"><ProductRail state={session.state} send={session.send} onOpenLibrary={() => setWorkspaceOpen(true)} /><MicPanel isListening={session.state.isListening} send={session.send} /><div className="rail-footer"><Wifi size={14} />局域网地址可供 iPad 访问</div></aside><section className="main-stage"><div className="stage-context"><div><span className="eyebrow">TODAY'S LIVE · 01</span><h2>{session.state.product.name}</h2></div><div className="context-actions"><span className="ai-tag"><ShieldCheck size={14} />豆包合规引擎</span><span className="context-dot" />火山实时语音</div></div><TranscriptStage state={session.state} send={session.send} /><DemoInput send={session.send} /></section><aside className="coach-rail"><PromptPanel state={session.state} /><CompliancePanel result={session.state.latestCompliance} /><section className="alert-history"><div className="section-kicker">近期提醒 <span>ALERT LOG</span></div>{session.state.alerts.length ? session.state.alerts.slice(0, 4).map((alert) => <div className="alert-row" key={alert.id}><div className={`alert-icon ${alert.risk}`}><RiskIcon risk={alert.risk} /></div><div><strong>{alert.title}</strong><small>{new Date(alert.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · {alert.alternative.replace(/^可以改为：/u, '')}</small></div></div>) : <div className="empty-alert"><Check size={16} />暂无风险提醒</div>}</section></aside></main><footer className="operator-footer"><SessionStats state={session.state} /><div className="footer-note"><Activity size={15} />风险判断以豆包大模型为主，未配置密钥时使用本地规则即时兜底</div></footer>{workspaceOpen && <WorkspaceModal state={session.state} actorId={session.actorId} send={session.send} onClose={() => setWorkspaceOpen(false)} />}</div>;
}

function DisplayScreen() {
  const session = useLiveSession('display');
  const result = session.state.latestCompliance;
  const latestSegment = session.state.transcriptHistory.at(-1);
  const risk = result?.risk ?? 'safe';
  return <div className={`app-shell display-shell risk-${risk}`}><AppHeader state={session.state} connected={session.connected} status={session.status} mode="display" /><main className="display-main"><div className="display-product"><img src={session.state.product.image} alt="" /><div><span className="eyebrow">ON AIR PRODUCT · {session.state.product.category}</span><h1>{session.state.product.name}</h1><strong>{session.state.product.price}</strong></div><div className="display-live"><span className="signal-dot on" />{session.state.isListening ? '正在收音' : '等待收音'}</div></div><section className="display-voice"><div className="display-voice-label"><Volume2 size={17} />主播刚刚说 <span>{formatReplayOffset(latestSegment?.offsetMs ?? null)}</span></div><div className="display-transcript">{session.state.partialTranscript || latestSegment?.text || '等待下一句转录…'}</div><Waveform active={session.state.isListening} /></section><section className={`display-alert ${risk}`}><div className="display-alert-head"><div className="display-risk-icon"><RiskIcon risk={risk} /></div><div><span className="eyebrow">{result ? '即时合规提醒' : '合规提词就绪'}</span><h2>{result ? <RiskLabel risk={risk} /> : '可以继续介绍当前商品'}</h2></div><span className="display-source">{result?.source === 'doubao' ? 'DOUBAO' : result?.source === 'custom-rule' ? 'CUSTOM RULE' : 'LOCAL GUARDRAIL'}</span></div><div className="display-divider" /><div className="display-prompt-label">{result && result.risk !== 'safe' ? '请立即替换为' : '推荐表达'}</div><p className="display-prompt">{result && result.risk !== 'safe' ? result.alternative : session.state.product.compliantPhrases[0]}</p>{result && result.risk !== 'safe' && <p className="display-reason"><AlertTriangle size={15} />{result.reason}</p>}</section></main><footer className="display-footer"><div><ShieldCheck size={15} />抖音直播合规实时预警</div><div className="display-footer-stats"><span>监测 {session.state.stats.words} 字</span><span>高风险 {session.state.stats.blockedCount}</span><span>需留意 {session.state.stats.warningCount}</span></div></footer></div>;
}

export default function App() {
  return window.location.pathname.startsWith('/display') ? <DisplayScreen /> : <OperatorScreen />;
}
