// autotask_create_ticket fills status and priority when the caller leaves
// them out. Autotask requires both on every new ticket and refuses the whole
// POST without them ("Missing Required Field: status"), which a caller only
// finds out after the write was approved. The server uses Autotask's own
// default for each field (the picklist value marked isDefaultValue), falls
// back to New (1) for status, and never overrides an explicit value.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

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

const STATUS = {
  name: 'status', isPickList: true,
  picklistValues: [
    { value: 1, label: 'New', isActive: true, isDefaultValue: false },
    { value: 8, label: 'In Progress', isActive: true },
  ],
};
const PRIORITY = {
  name: 'priority', isPickList: true,
  picklistValues: [
    { value: 1, label: 'High', isActive: true },
    { value: 2, label: 'Medium', isActive: true, isDefaultValue: true },
    { value: 3, label: 'Low', isActive: true },
  ],
};

function respond(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

interface Fake { fetch: jest.SpyInstance; posts: any[]; fieldCalls: () => number; fieldCallsBeforePost: () => number }

/** Routes the fake Autotask API; `fields` is what entityInformation/fields returns (or an HTTP status). */
function mockAutotask(fields: unknown[] | number): Fake {
  const posts: any[] = [];
  let fieldCalls = 0;
  let beforePost = -1;
  const spy = jest.spyOn(global, 'fetch' as any).mockImplementation(async (url: any, init: any) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'POST' && u.endsWith('/Tickets')) {
      if (beforePost < 0) beforePost = fieldCalls;
      posts.push(JSON.parse(init.body));
      return respond(200, { itemId: 441600 });
    }
    if (u.includes('/Tickets/entityInformation/fields')) {
      fieldCalls += 1;
      return typeof fields === 'number' ? respond(fields, { errors: ['nope'] }) : respond(200, { fields });
    }
    if (method === 'GET' && /\/Tickets\/441600$/.test(u)) {
      return respond(200, { item: { id: 441600, ticketNumber: 'T20261127.0100', status: 1 } });
    }
    return respond(404, { errors: [`unexpected ${method} ${u}`] });
  });
  return { fetch: spy, posts, fieldCalls: () => fieldCalls, fieldCallsBeforePost: () => beforePost };
}

const args = {
  companyID: 1,
  title: 'Printer offline',
  description: 'The printer is offline',
  dueDateTime: '2026-12-01T05:00:00Z',
  queueID: 8,
};

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

function handler(): AutotaskToolHandler {
  return new AutotaskToolHandler(new AutotaskService(config, logger), logger);
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

describe('autotask_create_ticket: default status and priority', () => {
  test('both omitted: New and the default priority are sent, and the message says so', async () => {
    const fake = mockAutotask([STATUS, PRIORITY]);
    const result = await handler().callTool('autotask_create_ticket', { ...args });

    expect(result.isError).toBeFalsy();
    expect(fake.posts).toHaveLength(1);
    expect(fake.posts[0]).toMatchObject({ status: 1, priority: 2 });
    expect(parse(result).message).toContain('Autotask defaults used: status New (1), priority Medium (2).');
  });

  test('a status marked as the default wins over New', async () => {
    const status = { ...STATUS, picklistValues: [
      { value: 1, label: 'New', isActive: true },
      { value: 25, label: 'Triage', isActive: true, isDefaultValue: true },
    ] };
    const fake = mockAutotask([status, PRIORITY]);
    await handler().callTool('autotask_create_ticket', { ...args });
    expect(fake.posts[0].status).toBe(25);
  });

  test('explicit values always win; nothing is looked up and the message has no defaults note', async () => {
    const fake = mockAutotask([STATUS, PRIORITY]);
    const result = await handler().callTool('autotask_create_ticket', { ...args, status: 8, priority: 1 });

    expect(fake.posts[0]).toMatchObject({ status: 8, priority: 1 });
    // (the read-back after the POST looks up labels on its own)
    expect(fake.fieldCallsBeforePost()).toBe(0);
    expect(parse(result).message).not.toContain('defaults used');
  });

  test('null counts as omitted', async () => {
    const fake = mockAutotask([STATUS, PRIORITY]);
    await handler().callTool('autotask_create_ticket', { ...args, status: null, priority: null });
    expect(fake.posts[0]).toMatchObject({ status: 1, priority: 2 });
  });

  test('only priority omitted: status is left as given', async () => {
    const fake = mockAutotask([STATUS, PRIORITY]);
    const result = await handler().callTool('autotask_create_ticket', { ...args, status: 8 });
    expect(fake.posts[0]).toMatchObject({ status: 8, priority: 2 });
    expect(parse(result).message).toContain('Autotask defaults used: priority Medium (2).');
  });

  test('an inactive default priority is not used', async () => {
    const priority = { ...PRIORITY, picklistValues: [
      { value: 2, label: 'Medium', isActive: false, isDefaultValue: true },
      { value: 3, label: 'Low', isActive: true },
    ] };
    const fake = mockAutotask([STATUS, priority]);
    const result = await handler().callTool('autotask_create_ticket', { ...args });
    expect(result.isError).toBe(true);
    expect(fake.posts).toHaveLength(0);
  });

  test('no default priority: refused before anything is sent, saying how to fix it', async () => {
    const priority = { ...PRIORITY, picklistValues: PRIORITY.picklistValues.map(v => ({ ...v, isDefaultValue: false })) };
    const fake = mockAutotask([STATUS, priority]);
    const result = await handler().callTool('autotask_create_ticket', { ...args });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('requires a priority');
    expect(result.content[0].text).toContain('autotask_list_ticket_priorities');
    expect(fake.posts).toHaveLength(0);
  });

  test('field lookup fails: status falls back to New, a given priority is used, and the next call looks up again', async () => {
    const fake = mockAutotask(500);
    const h = handler();
    const result = await h.callTool('autotask_create_ticket', { ...args, priority: 3 });

    expect(result.isError).toBeFalsy();
    expect(fake.posts[0]).toMatchObject({ status: 1, priority: 3 });
    const before = fake.fieldCalls();
    await h.callTool('autotask_create_ticket', { ...args, priority: 3 });
    expect(fake.fieldCalls()).toBeGreaterThan(before);
  });

  test('field lookup fails and priority is omitted: refused, nothing sent', async () => {
    const fake = mockAutotask(500);
    const result = await handler().callTool('autotask_create_ticket', { ...args });
    expect(result.isError).toBe(true);
    expect(fake.posts).toHaveLength(0);
  });

  test('the tool schema tells the model status and priority are required by Autotask and defaulted', () => {
    const tool = TOOL_DEFINITIONS.find(t => t.name === 'autotask_create_ticket')!;
    const props = (tool.inputSchema as any).properties;
    expect(props.status.description).toContain('Autotask requires a status');
    expect(props.status.description).toContain('autotask_list_ticket_statuses');
    expect(props.priority.description).toContain('Autotask requires a priority');
    expect(props.priority.description).toContain('autotask_list_ticket_priorities');
  });
});
