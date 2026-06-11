// parity/check.ts
import { createHash, createHmac } from 'node:crypto';

export interface Slot {
  readonly datetime?: string;
  readonly start_iso?: string;
  readonly startIso?: string;
  readonly available?: boolean;
}
export interface SlotsResponse { serviceId: string; slots: Slot[] }
interface BridgeSuccessResponse<T> { success: true; data: T }
export type DiffLevel = 'OK' | 'WARN' | 'CRITICAL';

export interface DiffResult {
  service: string;
  date: string;
  modalCount: number;
  k8sCount: number;
  level: DiffLevel;
  detail: string;
}

// Canonical HMAC input is `${ts}${path}${bodyHash}` where bodyHash is the
// sha256 hex digest of the raw request body (or the sha256 of the empty string
// for bodyless GETs). Method and host are intentionally omitted: the harness
// runs over Tailscale (single known host). Including the body hash binds the
// signature to the exact JSON payload so that POST /availability/slots cannot
// be replayed with a mutated body. For GETs, bodyHash is the sha256 of `''`,
// which keeps pre-body signatures stable on read-only endpoints.
// If the deployment ever fan-outs to multiple hosts, extend this to SigV4-
// style (METHOD + HOST + PATH + BODY_HASH + TS).
const sign = (secret: string, path: string, ts: string, body?: string): string => {
  const bodyHash = createHash('sha256').update(body ?? '').digest('hex');
  return createHmac('sha256', secret).update(`${ts}${path}${bodyHash}`).digest('hex');
};

const slotKey = (slot: Slot): string =>
  slot.datetime ?? slot.start_iso ?? slot.startIso ?? JSON.stringify(slot);

const availableSlotKeys = (response: SlotsResponse): string[] =>
  response.slots.filter(slot => slot.available !== false).map(slotKey);

const unwrapSlotsResponse = (payload: unknown, serviceId: string): SlotsResponse => {
  if (
    payload &&
    typeof payload === 'object' &&
    'success' in payload &&
    (payload as { success: unknown }).success === true &&
    Array.isArray((payload as BridgeSuccessResponse<unknown[]>).data)
  ) {
    return { serviceId, slots: (payload as BridgeSuccessResponse<Slot[]>).data };
  }

  if (
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { slots?: unknown }).slots)
  ) {
    const response = payload as { serviceId?: string; service_id?: string; slots: Slot[] };
    return {
      serviceId: response.serviceId ?? response.service_id ?? serviceId,
      slots: response.slots,
    };
  }

  throw new Error('Unexpected /availability/slots response shape');
};

export const classifyDiff = (modal: SlotsResponse, k8s: SlotsResponse): { level: DiffLevel; detail: string } => {
  const modalSet = new Set(availableSlotKeys(modal));
  const k8sSet = new Set(availableSlotKeys(k8s));
  const onlyModal = [...modalSet].filter(s => !k8sSet.has(s));
  const onlyK8s = [...k8sSet].filter(s => !modalSet.has(s));
  const drift = onlyModal.length + onlyK8s.length;

  if (drift <= 2) return { level: 'OK', detail: `drift=${drift}` };
  if (drift <= 5) return { level: 'WARN', detail: `drift=${drift}, onlyModal=${onlyModal.length}, onlyK8s=${onlyK8s.length}` };
  return { level: 'CRITICAL', detail: `drift=${drift}, onlyModal=${onlyModal.length}, onlyK8s=${onlyK8s.length}` };
};

export const fetchWithHmac = async (
  base: string,
  path: string,
  secret: string,
  bearerToken?: string,
  body?: unknown,
): Promise<unknown> => {
  const ts = Date.now().toString();
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const headers: Record<string, string> = {
    'X-Timestamp': ts,
    'X-Signature': sign(secret, path, ts, serialized),
  };
  if (bearerToken) {
    headers['Authorization'] = `Bearer ${bearerToken}`;
  }
  const init: RequestInit = body === undefined
    ? { headers }
    : {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: serialized,
      };
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) throw new Error(`${base}${path} → ${res.status}`);
  return res.json();
};

export interface ParityConfig {
  modalUrl: string;
  k8sUrl: string;
  hmacSecret: string;
  bearerToken?: string;
  serviceIds: string[];
  dateHorizonDays: number;
}

export const runParityCheck = async (cfg: ParityConfig): Promise<DiffResult[]> => {
  const results: DiffResult[] = [];
  const today = new Date();
  for (const sid of cfg.serviceIds) {
    for (let d = 0; d <= cfg.dateHorizonDays; d++) {
      const date = new Date(today);
      date.setDate(date.getDate() + d);
      const iso = date.toISOString().slice(0, 10);
      const path = `/availability/slots`;
      const body = { serviceId: sid, date: iso };
      try {
        const modal = unwrapSlotsResponse(
          await fetchWithHmac(cfg.modalUrl, path, cfg.hmacSecret, cfg.bearerToken, body),
          sid,
        );
        const k8s = unwrapSlotsResponse(
          await fetchWithHmac(cfg.k8sUrl, path, cfg.hmacSecret, cfg.bearerToken, body),
          sid,
        );
        const { level, detail } = classifyDiff(modal, k8s);
        results.push({
          service: sid,
          date: iso,
          modalCount: availableSlotKeys(modal).length,
          k8sCount: availableSlotKeys(k8s).length,
          level,
          detail,
        });
      } catch (e) {
        results.push({
          service: sid,
          date: iso,
          modalCount: -1,
          k8sCount: -1,
          level: 'CRITICAL',
          detail: `fetch error: ${String(e)}`,
        });
      }
    }
  }
  return results;
};

// CLI entry point (skip in tests)
if (import.meta.url === `file://${process.argv[1]}`) {
  (async (): Promise<void> => {
    const results = await runParityCheck({
      modalUrl: process.env.ACUITY_MW_MODAL_URL ?? process.env.MODAL_URL!,
      k8sUrl: process.env.ACUITY_MW_K8S_URL ?? process.env.K8S_URL!,
      hmacSecret: process.env.ACUITY_MW_HMAC_SECRET ?? process.env.HMAC_SECRET!,
      bearerToken: process.env.ACUITY_MW_AUTH_TOKEN,
      serviceIds: (process.env.ACUITY_MW_SERVICE_IDS ?? process.env.SERVICE_IDS ?? '').split(',').filter(Boolean),
      dateHorizonDays: Number(process.env.ACUITY_MW_DATE_HORIZON ?? process.env.DATE_HORIZON ?? 14),
    });

    for (const r of results) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), ...r }));
    }
    const critical = results.filter(r => r.level === 'CRITICAL').length;
    process.exit(critical > 0 ? 2 : 0);
  })().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
