import { type AddressInfo } from "node:net";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readViaUrlMocks = vi.hoisted(() => ({
  readDatesViaUrl: vi.fn(),
  readSlotsViaUrl: vi.fn(),
}));

const stepMocks = vi.hoisted(() => ({
  navigateToBooking: vi.fn(),
  fillFormFields: vi.fn(),
  bypassPayment: vi.fn(),
  generateCouponCode: vi.fn(),
  submitBooking: vi.fn(),
  extractConfirmation: vi.fn(),
  toBooking: vi.fn(),
  readAvailableDates: vi.fn(),
  readTimeSlots: vi.fn(),
  fetchBusinessData: vi.fn(),
  businessToServices: vi.fn(),
}));

const redisState = vi.hoisted(() => ({
  values: new Map<string, string>(),
  instances: [] as Array<{
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    ping: ReturnType<typeof vi.fn>;
    quit: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../../adapters/acuity/steps/read-via-url.js", () => readViaUrlMocks);
vi.mock("../../adapters/acuity/steps/index.js", () => stepMocks);

vi.mock("ioredis", () => {
  class Redis {
    get = vi.fn(async (key: string) => redisState.values.get(key) ?? null);

    set = vi.fn(
      async (
        key: string,
        value: string,
        ...args: Array<string | number>
      ): Promise<"OK" | null> => {
        const flags = args.map((arg) => String(arg).toUpperCase());
        if (flags.includes("NX") && redisState.values.has(key)) {
          return null;
        }
        redisState.values.set(key, value);
        return "OK";
      },
    );

    eval = vi.fn(
      async (
        _script: string,
        _numKeys: number,
        key: string,
        token: string,
      ): Promise<number> => {
        if (redisState.values.get(key) !== token) return 0;
        redisState.values.delete(key);
        return 1;
      },
    );

    exists = vi.fn(async (key: string) => (redisState.values.has(key) ? 1 : 0));
    ping = vi.fn(async () => "PONG");
    quit = vi.fn(async () => "OK");
    on = vi.fn(() => this);

    constructor() {
      redisState.instances.push(this);
    }
  }

  return { Redis };
});

const serviceId = "53178494";
const baseUrl = "https://MassageIthaca.as.me";
const slotDate = "2026-08-15";
const slotCacheKey = `bridge-read:v2:slots:${baseUrl}:${serviceId}:${slotDate}`;

const mockAcuityModules = () => {
  vi.doMock(
    "../../adapters/acuity/steps/read-via-url.js",
    () => readViaUrlMocks,
  );
  vi.doMock("../../adapters/acuity/steps/index.js", () => stepMocks);
};

const listen = async () => {
  const {
    server,
    __runEffectWithoutBrowserForTest,
    __setEffectRunnerForTest,
    __setAcuityStepOverridesForTest,
  } = await import("../handler.js");
  __setEffectRunnerForTest(__runEffectWithoutBrowserForTest);
  __setAcuityStepOverridesForTest({
    readDatesViaUrl: readViaUrlMocks.readDatesViaUrl,
    readSlotsViaUrl: readViaUrlMocks.readSlotsViaUrl,
    readAvailableDates: stepMocks.readAvailableDates,
    readTimeSlots: stepMocks.readTimeSlots,
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
};

const postAvailabilitySlots = async (
  url: string,
  body: unknown = { serviceId, date: slotDate },
): Promise<Response> =>
  fetch(`${url}/availability/slots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("POST /availability/slots read cache", () => {
  let activeServer: Awaited<ReturnType<typeof listen>>["server"] | null = null;

  beforeEach(() => {
    vi.resetModules();
    mockAcuityModules();
    vi.clearAllMocks();
    redisState.values.clear();
    redisState.instances.length = 0;

    process.env.ACUITY_BASE_URL = baseUrl;
    process.env.ACUITY_EMPTY_READ_CACHE_TTL_SECONDS = "7";
    process.env.ACUITY_READ_CACHE_TTL_SECONDS = "60";
    process.env.ACUITY_READ_CACHE_WAIT_TIMEOUT_MS = "10";
    process.env.REDIS_URL = "redis://unit.test:6379";
    delete process.env.REDIS_PASSWORD;
    delete process.env.AUTH_TOKEN;

    readViaUrlMocks.readSlotsViaUrl.mockImplementation(
      (_serviceId: string, date: string) =>
        Effect.succeed([
          {
            datetime: `${date}T18:00:00.000Z`,
            available: true,
          },
        ]),
    );
  });

  afterEach(async () => {
    if (activeServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        activeServer!.close((error) => (error ? reject(error) : resolve()));
      });
    }
    activeServer = null;
    delete process.env.ACUITY_BASE_URL;
    delete process.env.ACUITY_EMPTY_READ_CACHE_TTL_SECONDS;
    delete process.env.ACUITY_READ_CACHE_TTL_SECONDS;
    delete process.env.ACUITY_READ_CACHE_WAIT_TIMEOUT_MS;
    delete process.env.REDIS_URL;
    delete process.env.REDIS_PASSWORD;
    delete process.env.AUTH_TOKEN;
  });

  it("serves repeated slot requests from Redis without rereading Acuity", async () => {
    const running = await listen();
    activeServer = running.server;

    const first = await postAvailabilitySlots(running.baseUrl);

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      success: true,
      data: [{ datetime: `${slotDate}T18:00:00.000Z`, available: true }],
    });
    expect(redisState.values.get(slotCacheKey)).toBe(
      JSON.stringify([
        { datetime: `${slotDate}T18:00:00.000Z`, available: true },
      ]),
    );

    readViaUrlMocks.readSlotsViaUrl.mockClear();

    const second = await postAvailabilitySlots(running.baseUrl);

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      success: true,
      data: [{ datetime: `${slotDate}T18:00:00.000Z`, available: true }],
    });
    expect(readViaUrlMocks.readSlotsViaUrl).not.toHaveBeenCalled();
  });

  it("single-flights concurrent cold slot requests at the HTTP route", async () => {
    process.env.ACUITY_READ_CACHE_WAIT_TIMEOUT_MS = "1000";
    const releaseRead = deferred();
    const readStarted = deferred();
    readViaUrlMocks.readSlotsViaUrl.mockImplementationOnce(
      (_serviceId: string, date: string) =>
        Effect.promise(async () => {
          readStarted.resolve();
          await releaseRead.promise;
          return [
            {
              datetime: `${date}T18:00:00.000Z`,
              available: true,
            },
          ];
        }),
    );
    const running = await listen();
    activeServer = running.server;

    const responsesPromise = Promise.all(
      Array.from({ length: 3 }, () => postAvailabilitySlots(running.baseUrl)),
    );
    await readStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    releaseRead.resolve();

    const responses = await responsesPromise;

    expect(readViaUrlMocks.readSlotsViaUrl).toHaveBeenCalledTimes(1);
    for (const response of responses) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        success: true,
        data: [{ datetime: `${slotDate}T18:00:00.000Z`, available: true }],
      });
    }
    expect(redisState.values.get(slotCacheKey)).toBe(
      JSON.stringify([
        { datetime: `${slotDate}T18:00:00.000Z`, available: true },
      ]),
    );
  });

  it("uses the empty-read TTL for empty slot arrays", async () => {
    readViaUrlMocks.readSlotsViaUrl.mockImplementationOnce(() =>
      Effect.succeed([]),
    );
    const running = await listen();
    activeServer = running.server;

    const response = await postAvailabilitySlots(running.baseUrl);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: [],
    });
    expect(redisState.instances[0]?.set).toHaveBeenCalledWith(
      slotCacheKey,
      JSON.stringify([]),
      "EX",
      7,
    );
  });

  it("returns timeout instead of rereading Acuity when another caller owns the cache fill", async () => {
    redisState.values.set(`lock:${slotCacheKey}`, "winner-token");
    const running = await listen();
    activeServer = running.server;

    const response = await postAvailabilitySlots(running.baseUrl);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        tag: "InfrastructureError",
        code: "TIMEOUT",
      },
    });
    expect(readViaUrlMocks.readSlotsViaUrl).not.toHaveBeenCalled();
  });

  it("rejects missing service id before cache lookup or Acuity reads", async () => {
    const running = await listen();
    activeServer = running.server;

    const response = await postAvailabilitySlots(running.baseUrl, {
      date: slotDate,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        tag: "ValidationError",
        code: "serviceId",
      },
    });
    expect(readViaUrlMocks.readSlotsViaUrl).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated slot requests before cache lookup or Acuity reads", async () => {
    process.env.AUTH_TOKEN = "bridge-secret";
    const running = await listen();
    activeServer = running.server;

    const response = await postAvailabilitySlots(running.baseUrl);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        tag: "InfrastructureError",
        code: "UNAUTHORIZED",
      },
    });
    expect(readViaUrlMocks.readSlotsViaUrl).not.toHaveBeenCalled();
  });

  it("does not run slot reads for unsupported methods", async () => {
    const running = await listen();
    activeServer = running.server;

    const response = await fetch(`${running.baseUrl}/availability/slots`, {
      method: "GET",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: {
        tag: "InfrastructureError",
        code: "NOT_FOUND",
      },
    });
    expect(readViaUrlMocks.readSlotsViaUrl).not.toHaveBeenCalled();
  });
});
