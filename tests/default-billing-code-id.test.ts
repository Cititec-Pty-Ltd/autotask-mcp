// AUTOTASK_DEFAULT_BILLING_CODE_ID: autotask_create_ticket uses this work type
// (billing code) when the caller gives no billingCodeID. Same rules as
// AUTOTASK_DEFAULT_QUEUE_ID: an explicit billingCodeID always wins (null
// included), a malformed value is a startup error, and gateway mode ignores
// it because a billing code ID belongs to one tenant. Also covers the
// read-only autotask_list_billing_codes tool used to find the ID.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { AutotaskMcpServer } from '../src/mcp/server';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import {
  _resetZoneUrlCache,
  loadEnvironmentConfig,
  parseDefaultBillingCodeId,
  type EnvironmentConfig,
} from '../src/utils/config';

const logger = new Logger('error');

const config: McpServerConfig = {
  name: 'test-server',
  version: '0.0.0',
  autotask: {
    username: 'user@example.com',
    secret: 'secret',
    integrationCode: 'integration-code',
    apiUrl: 'https://webservices2.autotask.net/ATServicesRest/',
  },
};

function mockFetchOk(body: unknown): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

function ticketPost(fetchMock: jest.SpyInstance): any {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => String(url).endsWith('/Tickets') && (init as RequestInit)?.method === 'POST'
  );
  expect(call).toBeDefined();
  return JSON.parse((call![1] as RequestInit).body as string);
}

const baseTicket = {
  companyID: 1,
  title: 'Printer offline',
  description: 'The printer is offline',
  status: 1,
  priority: 2,
  dueDateTime: '2026-12-01T05:00:00Z',
};

beforeEach(() => {
  _resetZoneUrlCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('parseDefaultBillingCodeId', () => {
  test('unset or empty means no default', () => {
    expect(parseDefaultBillingCodeId(undefined)).toBeUndefined();
    expect(parseDefaultBillingCodeId('')).toBeUndefined();
    expect(parseDefaultBillingCodeId('   ')).toBeUndefined();
  });

  test('a positive integer is accepted (surrounding whitespace trimmed)', () => {
    expect(parseDefaultBillingCodeId('4242')).toBe(4242);
    expect(parseDefaultBillingCodeId(' 8 ')).toBe(8);
  });

  test.each(['Remote Support', '0', '-1', '1.5', '1e3', '0x10', '12abc', '+5', '99999999999999999999'])(
    'refuses %p with a clear error',
    (raw) => {
      expect(() => parseDefaultBillingCodeId(raw)).toThrow(/Invalid AUTOTASK_DEFAULT_BILLING_CODE_ID/);
    }
  );
});

describe('loadEnvironmentConfig', () => {
  const saved = process.env.AUTOTASK_DEFAULT_BILLING_CODE_ID;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTOTASK_DEFAULT_BILLING_CODE_ID;
    else process.env.AUTOTASK_DEFAULT_BILLING_CODE_ID = saved;
  });

  test('reads AUTOTASK_DEFAULT_BILLING_CODE_ID', () => {
    process.env.AUTOTASK_DEFAULT_BILLING_CODE_ID = '4242';
    expect(loadEnvironmentConfig().autotask.defaultBillingCodeId).toBe(4242);
  });

  test('leaves it unset when the variable is absent', () => {
    delete process.env.AUTOTASK_DEFAULT_BILLING_CODE_ID;
    expect(loadEnvironmentConfig().autotask.defaultBillingCodeId).toBeUndefined();
  });

  test('a malformed value stops startup instead of being ignored', () => {
    process.env.AUTOTASK_DEFAULT_BILLING_CODE_ID = 'Remote Support';
    expect(() => loadEnvironmentConfig()).toThrow(/Invalid AUTOTASK_DEFAULT_BILLING_CODE_ID/);
  });

  test('gateway mode does not parse it: a malformed value neither stops startup nor applies', () => {
    const savedMode = process.env.AUTH_MODE;
    const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.AUTH_MODE = 'gateway';
      process.env.AUTOTASK_DEFAULT_BILLING_CODE_ID = 'Remote Support';
      expect(loadEnvironmentConfig().autotask.defaultBillingCodeId).toBeUndefined();
      process.env.AUTOTASK_DEFAULT_BILLING_CODE_ID = '4242';
      expect(loadEnvironmentConfig().autotask.defaultBillingCodeId).toBeUndefined();
      expect(warn.mock.calls.some(c => String(c[0]).includes('AUTOTASK_DEFAULT_BILLING_CODE_ID is ignored'))).toBe(true);
    } finally {
      if (savedMode === undefined) delete process.env.AUTH_MODE;
      else process.env.AUTH_MODE = savedMode;
    }
  });
});

describe('autotask_create_ticket with a default work type', () => {
  test('uses the default work type when billingCodeID is omitted', async () => {
    const fetchMock = mockFetchOk({ itemId: 601 });
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger, false, {
      defaultBillingCodeId: 4242,
    });

    const result = await handler.callTool('autotask_create_ticket', { ...baseTicket });

    expect(result.isError).toBeFalsy();
    expect(ticketPost(fetchMock).billingCodeID).toBe(4242);
    expect(result.content[0].text).toContain('default work type (billingCodeID 4242)');
  });

  test('an explicit billingCodeID always wins', async () => {
    const fetchMock = mockFetchOk({ itemId: 602 });
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger, false, {
      defaultBillingCodeId: 4242,
    });

    const result = await handler.callTool('autotask_create_ticket', { ...baseTicket, billingCodeID: 7 });

    expect(result.isError).toBeFalsy();
    expect(ticketPost(fetchMock).billingCodeID).toBe(7);
    expect(result.content[0].text).not.toContain('default work type');
  });

  test('an explicit null billingCodeID is passed through, not replaced', async () => {
    const fetchMock = mockFetchOk({ itemId: 603 });
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger, false, {
      defaultBillingCodeId: 4242,
    });

    await handler.callTool('autotask_create_ticket', { ...baseTicket, billingCodeID: null });

    expect(ticketPost(fetchMock).billingCodeID).toBeNull();
  });

  test('without a default, an omitted billingCodeID stays omitted', async () => {
    const fetchMock = mockFetchOk({ itemId: 604 });
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);

    await handler.callTool('autotask_create_ticket', { ...baseTicket });

    expect('billingCodeID' in ticketPost(fetchMock)).toBe(false);
  });

  test('works alongside the default queue', async () => {
    const fetchMock = mockFetchOk({ itemId: 605 });
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger, false, {
      defaultQueueId: 8888,
      defaultBillingCodeId: 4242,
    });

    await handler.callTool('autotask_create_ticket', { ...baseTicket });

    const body = ticketPost(fetchMock);
    expect(body.queueID).toBe(8888);
    expect(body.billingCodeID).toBe(4242);
  });

  test('autotask_update_ticket never applies the default', async () => {
    const fetchMock = mockFetchOk({ itemId: 606 });
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger, false, {
      defaultBillingCodeId: 4242,
    });

    await handler.callTool('autotask_update_ticket', { ticketId: 606, title: 'Renamed' });

    const bodies = fetchMock.mock.calls
      .map(([, init]) => (init as RequestInit)?.body)
      .filter((b): b is string => typeof b === 'string');
    expect(bodies.some(b => b.includes('4242'))).toBe(false);
  });
});

describe('tool description', () => {
  test('stays static: it never names the configured work type', () => {
    const create = TOOL_DEFINITIONS.find(t => t.name === 'autotask_create_ticket')!;
    const desc = (create.inputSchema.properties as any).billingCodeID.description as string;
    expect(desc).toMatch(/configured default work type/);
    expect(desc).not.toMatch(/[0-9]/);
    expect(desc).toMatch(/Pass null/);
  });

  test('the published schema accepts billingCodeID: null and keeps it optional', async () => {
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger, false, {
      defaultBillingCodeId: 12345,
    });
    const published = (await handler.listTools()).find(t => t.name === 'autotask_create_ticket')!;
    const billingCodeID = published.inputSchema.properties.billingCodeID;
    expect(billingCodeID.type).toEqual(['number', 'null']);
    expect(published.inputSchema.required ?? []).not.toContain('billingCodeID');

    const validate = new AjvJsonSchemaValidator().getValidator(published.inputSchema as any);
    expect(validate({ ...baseTicket, billingCodeID: null }).valid).toBe(true);
    expect(validate({ ...baseTicket, billingCodeID: 12345 }).valid).toBe(true);
    expect(validate({ ...baseTicket }).valid).toBe(true);
    expect(validate({ ...baseTicket, billingCodeID: '12345' }).valid).toBe(false);

    const plain = new AutotaskToolHandler(new AutotaskService(config, logger), logger);
    const unconfigured = (await plain.listTools()).find(t => t.name === 'autotask_create_ticket')!;
    expect(unconfigured.inputSchema).toEqual(published.inputSchema);
  });
});

describe('AutotaskMcpServer wiring', () => {
  function envConfig(mode: 'env' | 'gateway'): EnvironmentConfig {
    return {
      autotask: { ...config.autotask, defaultBillingCodeId: 4242 },
      server: { name: 'test-server', version: '0.0.0' },
      transport: { type: 'stdio', port: 8080, host: '127.0.0.1' },
      logging: { level: 'error', format: 'simple' },
      auth: { mode },
    };
  }

  test('env mode passes the default to the shared and per-request tool handlers', () => {
    const server = new AutotaskMcpServer(config, logger, envConfig('env')) as any;
    expect(server.toolHandler.defaultBillingCodeId).toBe(4242);
    const perRequest = server.buildPerRequestHandlers({ ...config.autotask, impersonationResourceId: 7 });
    expect(perRequest.toolHandler.defaultBillingCodeId).toBe(4242);
  });

  test('gateway mode ignores it (billing code IDs are tenant-specific)', () => {
    const server = new AutotaskMcpServer(config, logger, envConfig('gateway')) as any;
    expect(server.toolHandler.defaultBillingCodeId).toBeUndefined();
    const perRequest = server.buildPerRequestHandlers({ ...config.autotask, impersonationResourceId: undefined });
    expect(perRequest.toolHandler.defaultBillingCodeId).toBeUndefined();
  });
});

describe('Cloudflare Worker', () => {
  const MCP_HEADERS = { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  const listTools = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

  // The Worker caches its app server per isolate, so each case loads a fresh
  // copy of the module.
  async function freshWorker(): Promise<any> {
    let mod: any;
    await jest.isolateModulesAsync(async () => {
      mod = await import('../src/worker');
    });
    return mod.default;
  }

  test('gateway mode does not parse the value, so a malformed one cannot fail requests', async () => {
    const worker = await freshWorker();
    const res: Response = await worker.fetch(
      new Request('http://worker.local/mcp', {
        method: 'POST',
        headers: {
          ...MCP_HEADERS,
          'X-API-Key': 'test-user',
          'X-API-Secret': 'test-secret',
          'X-Integration-Code': 'test-code',
        },
        body: JSON.stringify(listTools),
      }),
      { AUTH_MODE: 'gateway', AUTOTASK_DEFAULT_BILLING_CODE_ID: 'not-a-number' }
    );
    expect(res.status).toBe(200);
  });

  test('env mode refuses a malformed value', async () => {
    const worker = await freshWorker();
    await expect(
      worker.fetch(
        new Request('http://worker.local/mcp', {
          method: 'POST',
          headers: MCP_HEADERS,
          body: JSON.stringify(listTools),
        }),
        { AUTOTASK_DEFAULT_BILLING_CODE_ID: 'not-a-number' }
      )
    ).rejects.toThrow(/Invalid AUTOTASK_DEFAULT_BILLING_CODE_ID/);
  });
});

describe('autotask_list_billing_codes', () => {
  const codes = [
    { id: 4242, name: 'Remote Support', useType: 1, isActive: true, hourlyRate: 100 },
    { id: 4243, name: 'General Administration', useType: 3, isActive: true },
  ];

  function queryBodies(fetchMock: jest.SpyInstance): any[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/BillingCodes/query'))
      .map(([, init]) => JSON.parse((init as RequestInit).body as string));
  }

  test('is a read-only utility tool', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'autotask_list_billing_codes')!;
    expect(tool).toBeDefined();
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(TOOL_CATEGORIES.utility.tools).toContain('autotask_list_billing_codes');
  });

  test('defaults to active codes and returns id, name, useType and isActive only', async () => {
    const fetchMock = mockFetchOk({ items: codes, pageDetails: {} });
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);

    const result = await handler.callTool('autotask_list_billing_codes', {});

    expect(result.isError).toBeFalsy();
    const [body] = queryBodies(fetchMock);
    expect(body.filter).toEqual([{ op: 'eq', field: 'isActive', value: true }]);
    const data = JSON.parse(result.content[0].text).data;
    expect(data[0]).toMatchObject({ id: 4242, name: 'Remote Support', useType: 1, isActive: true });
    expect(data[0].hourlyRate).toBeUndefined();
  });

  test('filters by name (contains), useType and isActive; null lists all', async () => {
    const fetchMock = mockFetchOk({ items: codes.slice(0, 1), pageDetails: {} });
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);

    await handler.callTool('autotask_list_billing_codes', { name: ' Remote ', useType: 1, isActive: null });

    const [body] = queryBodies(fetchMock);
    expect(body.filter).toEqual([
      { op: 'contains', field: 'name', value: 'Remote' },
      { op: 'eq', field: 'useType', value: 1 },
    ]);
  });

  test('isActive: false lists inactive codes', async () => {
    const fetchMock = mockFetchOk({ items: [], pageDetails: {} });
    const handler = new AutotaskToolHandler(new AutotaskService(config, logger), logger);

    await handler.callTool('autotask_list_billing_codes', { isActive: false });

    const [body] = queryBodies(fetchMock);
    expect(body.filter).toEqual([{ op: 'eq', field: 'isActive', value: false }]);
  });
});
