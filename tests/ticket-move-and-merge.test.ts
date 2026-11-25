// autotask_update_ticket company/contract/queue changes and autotask_merge_ticket.
//
// Autotask's REST API has no ticket merge, and a PATCH that changes a
// ticket's company does not pick a contract the way the UI does. These tests
// drive TicketOps (and the tool handler) against an in-memory fake of the
// service, with made-up IDs and names.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API'))
  }
}));

import { TicketOps, TicketOpsError, MAX_ATTACHMENT_BYTES, type TicketOpsService } from '../src/handlers/ticket-move';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS, TOOL_CATEGORIES } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import type { FieldInfo } from '../src/services/picklist.cache';

const COMPLETE = 5;

const TICKET_FIELDS: FieldInfo[] = [
  {
    name: 'status', dataType: 'integer', isRequired: true, isReadOnly: false, isQueryable: true, isReference: false, isPickList: true,
    picklistValues: [{ value: '1', label: 'New' }, { value: '8', label: 'In Progress' }, { value: String(COMPLETE), label: 'Complete' }],
  },
  {
    name: 'queueID', dataType: 'integer', isRequired: false, isReadOnly: false, isQueryable: true, isReference: false, isPickList: true,
    picklistValues: [{ value: '10', label: 'Triage', isActive: true }, { value: '11', label: 'Level II Support', isActive: true }, { value: '12', label: 'Old queue', isActive: false }],
  },
  {
    name: 'ticketType', dataType: 'integer', isRequired: false, isReadOnly: false, isQueryable: true, isReference: false, isPickList: true,
    picklistValues: [{ value: '1', label: 'Service Request' }, { value: '2', label: 'Incident' }, { value: '3', label: 'Problem' }, { value: '4', label: 'Change Request' }],
  },
];

const NOTE_FIELDS: FieldInfo[] = [
  { name: 'description', dataType: 'string', length: 32000, isRequired: true, isReadOnly: false, isQueryable: true, isReference: false, isPickList: false },
  { name: 'title', dataType: 'string', length: 250, isRequired: false, isReadOnly: false, isQueryable: true, isReference: false, isPickList: false },
  {
    name: 'noteType', dataType: 'integer', isRequired: true, isReadOnly: false, isQueryable: true, isReference: false, isPickList: true,
    picklistValues: [{ value: '1', label: 'Task Summary' }, { value: '3', label: 'Task Detail', isDefaultValue: true }],
  },
  {
    name: 'publish', dataType: 'integer', isRequired: true, isReadOnly: false, isQueryable: true, isReference: false, isPickList: true,
    picklistValues: [{ value: '1', label: 'All Autotask Users' }, { value: '2', label: 'Internal Only' }],
  },
];

interface World {
  tickets: Record<number, any>;
  companies: Record<number, any>;
  contracts: any[];
  contacts: Record<number, any>;
  cis: Record<number, any>;
  resources: Record<number, any>;
  notes: Record<number, any[]>;
  attachments: Record<number, any[]>;
  attachmentData: Record<number, string>;
}

function world(): World {
  return {
    tickets: {
      100: { id: 100, ticketNumber: 'T20990101.0001', title: 'Printer offline', description: 'The printer on level 2 is offline.', companyID: 1, contractID: 501, contactID: 70, queueID: 10, status: 1, ticketType: 2, createDate: '2099-01-01T01:00:00Z' },
      200: { id: 200, ticketNumber: 'T20990101.0002', title: 'Printing broken', description: 'Nothing prints.', companyID: 2, contractID: 601, contactID: 80, queueID: 11, status: 8, ticketType: 1, createDate: '2099-01-01T02:00:00Z' },
    },
    companies: {
      1: { id: 1, companyName: 'Example Old Pty Ltd', isActive: true },
      2: { id: 2, companyName: 'Example New Pty Ltd', isActive: true },
      3: { id: 3, companyName: 'Example Nodefault Pty Ltd', isActive: true },
      4: { id: 4, companyName: 'Example Closed Pty Ltd', isActive: false },
    },
    contracts: [
      { id: 501, companyID: 1, contractName: 'Old Co Managed Services', status: 1, isDefaultContract: true },
      { id: 601, companyID: 2, contractName: 'New Co Managed Services', status: 1, isDefaultContract: true },
      { id: 602, companyID: 2, contractName: 'New Co Block Hours', status: 1, isDefaultContract: false },
      { id: 603, companyID: 2, contractName: 'New Co Expired', status: 0, isDefaultContract: false },
      { id: 701, companyID: 3, contractName: 'Nodefault Project', status: 1, isDefaultContract: false },
    ],
    contacts: {
      70: { id: 70, companyID: 1, firstName: 'Alex', lastName: 'Old' },
      80: { id: 80, companyID: 2, firstName: 'Sam', lastName: 'New' },
    },
    cis: { 900: { id: 900, companyID: 1 } },
    resources: { 30: { id: 30, firstName: 'Tech', lastName: 'One' } },
    notes: {
      100: [
        { id: 1001, ticketID: 100, title: 'Called user', description: 'User says it shows an error.', creatorResourceID: 30, createDateTime: '2099-01-01T03:00:00Z' },
        { id: 1002, ticketID: 100, title: 'Customer reply', description: 'Still broken.', createdByContactID: 70, createDateTime: '2099-01-01T04:00:00Z' },
      ],
      200: [],
    },
    attachments: {
      100: [
        { id: 3001, ticketID: 100, title: 'error.png', fullPath: 'error.png', attachmentType: 'FILE_ATTACHMENT', fileSize: 4, contentType: 'image/png', publish: 1 },
        { id: 3002, ticketID: 100, title: 'Vendor KB', fullPath: 'https://kb.example.invalid/1', attachmentType: 'URL' },
        { id: 3003, ticketID: 100, title: 'dump.zip', fullPath: 'dump.zip', attachmentType: 'FILE_ATTACHMENT', fileSize: MAX_ATTACHMENT_BYTES + 1 },
      ],
      200: [],
    },
    attachmentData: { 3001: Buffer.from('PNG!').toString('base64') },
  };
}

function fakeService(w: World, overrides: Partial<Record<keyof TicketOpsService | 'getFieldInfo', jest.Mock>> = {}) {
  let nextId = 50000;
  const svc = {
    getTicket: jest.fn(async (id: number) => (w.tickets[id] ? { ...w.tickets[id] } : null)),
    getCompany: jest.fn(async (id: number) => w.companies[id] ?? null),
    getContract: jest.fn(async (id: number) => w.contracts.find(c => c.id === id) ?? null),
    searchContracts: jest.fn(async (o: any) => w.contracts.filter(c =>
      c.companyID === o.companyID
      && (o.status === undefined || c.status === o.status)
      && (!o.filter || o.filter.isDefaultContract === undefined || c.isDefaultContract === o.filter.isDefaultContract))),
    getContact: jest.fn(async (id: number) => w.contacts[id] ?? null),
    getConfigurationItem: jest.fn(async (id: number) => w.cis[id] ?? null),
    getResource: jest.fn(async (id: number) => w.resources[id] ?? null),
    updateTicket: jest.fn(async (id: number, p: any) => { Object.assign(w.tickets[id], p); }),
    searchTicketNotes: jest.fn(async (id: number) => [...(w.notes[id] ?? [])]),
    createTicketNote: jest.fn(async (id: number, n: any) => {
      const note = { id: ++nextId, ticketID: id, ...n };
      (w.notes[id] ??= []).push(note);
      return note.id;
    }),
    searchTicketAttachments: jest.fn(async (id: number) => [...(w.attachments[id] ?? [])]),
    getTicketAttachment: jest.fn(async (tid: number, aid: number) => {
      const a = (w.attachments[tid] ?? []).find(x => x.id === aid);
      return a ? { ...a, data: w.attachmentData[aid] } : null;
    }),
    createTicketAttachment: jest.fn(async (tid: number, d: any) => {
      const a = { id: ++nextId, ticketID: tid, attachmentType: 'FILE_ATTACHMENT', fileSize: Buffer.from(d.data, 'base64').length, ...d };
      (w.attachments[tid] ??= []).push(a);
      return a.id;
    }),
    getFieldInfo: jest.fn(async (entity: string) => (entity === 'Tickets' ? TICKET_FIELDS : entity === 'TicketNotes' ? NOTE_FIELDS : [])),
    getTenantKey: jest.fn(() => null),
    ...overrides,
  };
  return svc;
}

function ops(svc: ReturnType<typeof fakeService>) {
  return new TicketOps(svc as unknown as TicketOpsService, { getFields: (e: string) => svc.getFieldInfo(e) } as any);
}

function handler(svc: ReturnType<typeof fakeService>) {
  return new AutotaskToolHandler(svc as any, new Logger('error'));
}

function parse(r: { content: Array<{ text: string }>; isError?: boolean }) {
  return JSON.parse(r.content[0]!.text);
}

describe('Feature A: company, contract and queue on a ticket (planTicketChange)', () => {
  test('a company move sets the new company\'s default contract and removes the old company\'s contact', async () => {
    const w = world();
    const svc = fakeService(w);
    const plan = await ops(svc).planTicketChange(w.tickets[100], { companyID: 2 });
    expect(plan.payload).toEqual({ companyID: 2, contractID: 601, contactID: null });
    expect(plan.company).toEqual({ from: { id: 1, name: 'Example Old Pty Ltd' }, to: { id: 2, name: 'Example New Pty Ltd' } });
    expect(plan.contract?.to).toEqual({ id: 601, name: 'New Co Managed Services' });
    expect(plan.lines.join(' ')).toContain('Contract: Old Co Managed Services (ID 501) → New Co Managed Services (ID 601) (the default contract of Example New Pty Ltd).');
    expect(plan.lines.join(' ')).toContain('Contact: Alex Old (ID 70) removed from the ticket: the contact belongs to Example Old Pty Ltd.');
    // The default is looked up as the active, default contract of the new company.
    expect(svc.searchContracts).toHaveBeenCalledWith(expect.objectContaining({ companyID: 2, status: 1, filter: { isDefaultContract: true } }));
  });

  test('a company with no default contract leaves the ticket without a contract, and says so', async () => {
    const w = world();
    const plan = await ops(fakeService(w)).planTicketChange(w.tickets[100], { companyID: 3 });
    expect(plan.payload.contractID).toBeNull();
    expect(plan.contract?.to).toEqual({ id: null, name: 'none' });
    expect(plan.lines.join(' ')).toContain('Contract: Old Co Managed Services (ID 501) → no contract (Example Nodefault Pty Ltd has no default contract, so the ticket has no contract).');
  });

  test('an explicit contractID of the new company is used instead of the default', async () => {
    const w = world();
    const plan = await ops(fakeService(w)).planTicketChange(w.tickets[100], { companyID: 2, contractID: 602 });
    expect(plan.payload.contractID).toBe(602);
    expect(plan.lines.join(' ')).toContain('→ New Co Block Hours (ID 602) (as requested)');
  });

  test('a contractID of another company, or an inactive one, is refused', async () => {
    const w = world();
    const o = ops(fakeService(w));
    await expect(o.planTicketChange(w.tickets[100], { companyID: 2, contractID: 501 }))
      .rejects.toThrow('Contract Old Co Managed Services (ID 501) belongs to Example Old Pty Ltd (ID 1), not to Example New Pty Ltd (ID 2)');
    await expect(o.planTicketChange(w.tickets[100], { companyID: 2, contractID: 603 })).rejects.toThrow('is not active');
    await expect(o.planTicketChange(w.tickets[100], { companyID: 2, contractID: 99999 })).rejects.toThrow('Contract 99999 was not found');
  });

  test('contractID without a company change is validated against the ticket\'s own company', async () => {
    const w = world();
    const o = ops(fakeService(w));
    await expect(o.planTicketChange(w.tickets[100], { contractID: 601 })).rejects.toThrow(TicketOpsError);
    const plan = await o.planTicketChange(w.tickets[200], { contractID: 602 });
    expect(plan.payload).toEqual({ contractID: 602 });
    expect(plan.company).toBeUndefined();
  });

  test('a contactID of the new company is kept; one of another company is refused', async () => {
    const w = world();
    const o = ops(fakeService(w));
    const plan = await o.planTicketChange(w.tickets[100], { companyID: 2, contactID: 80 });
    expect(plan.payload.contactID).toBe(80);
    expect(plan.lines.join(' ')).toContain('Contact: Alex Old (ID 70) → Sam New (ID 80).');
    await expect(o.planTicketChange(w.tickets[100], { companyID: 2, contactID: 70 })).rejects.toThrow('does not belong to Example New Pty Ltd');
  });

  test('a configuration item and location of the old company, and the old contract\'s service, are removed', async () => {
    const w = world();
    Object.assign(w.tickets[100], { configurationItemID: 900, companyLocationID: 44, contractServiceID: 55 });
    const plan = await ops(fakeService(w)).planTicketChange(w.tickets[100], { companyID: 2 });
    expect(plan.payload).toMatchObject({ configurationItemID: null, companyLocationID: null, contractServiceID: null });
    expect(plan.cleared).toEqual(expect.arrayContaining(['configurationItemID', 'companyLocationID', 'contractServiceID']));
  });

  test('inactive or unknown companies, and project tickets, are refused', async () => {
    const w = world();
    const o = ops(fakeService(w));
    await expect(o.planTicketChange(w.tickets[100], { companyID: 4 })).rejects.toThrow('inactive');
    await expect(o.planTicketChange(w.tickets[100], { companyID: 77 })).rejects.toThrow('Company 77 was not found');
    await expect(o.planTicketChange({ ...w.tickets[100], projectID: 5 }, { companyID: 2 })).rejects.toThrow('belongs to project 5');
  });

  test('a queue change names both queues; an inactive or unknown queue is refused', async () => {
    const w = world();
    const o = ops(fakeService(w));
    const plan = await o.planTicketChange(w.tickets[100], { queueID: 11 });
    expect(plan.payload).toEqual({ queueID: 11 });
    expect(plan.lines).toEqual(['Queue: Triage (ID 10) → Level II Support (ID 11).']);
    await expect(o.planTicketChange(w.tickets[100], { queueID: 12 })).rejects.toThrow('not an active queue');
    await expect(o.planTicketChange(w.tickets[100], { queueID: 999 })).rejects.toThrow('not an active queue');
  });
});

describe('autotask_update_ticket (handler)', () => {
  test('a move sends only what changes and states old → new company, contract, queue and contact', async () => {
    const w = world();
    const svc = fakeService(w);
    const r = await handler(svc).callTool('autotask_update_ticket', { ticketId: 100, companyID: 2, queueID: 11, title: 'Printer offline (moved)' });
    expect(r.isError).toBeFalsy();
    expect(svc.updateTicket).toHaveBeenCalledWith(100, {
      title: 'Printer offline (moved)', companyID: 2, contractID: 601, contactID: null, queueID: 11,
    });
    const body = parse(r);
    expect(body.message).toContain('Updated ticket T20990101.0001 (ID 100).');
    expect(body.message).toContain('Company: Example Old Pty Ltd (ID 1) → Example New Pty Ltd (ID 2).');
    expect(body.message).toContain('Contract: Old Co Managed Services (ID 501) → New Co Managed Services (ID 601)');
    expect(body.message).toContain('Queue: Triage (ID 10) → Level II Support (ID 11).');
    expect(body.message).toContain('Alex Old (ID 70) removed');
    expect(body.data).toBe(100);
    expect(body.changes.contract.to).toEqual({ id: 601, name: 'New Co Managed Services' });
  });

  test('a refused move writes nothing', async () => {
    const w = world();
    const svc = fakeService(w);
    const r = await handler(svc).callTool('autotask_update_ticket', { ticketId: 100, companyID: 2, contractID: 501 });
    expect(r.isError).toBe(true);
    expect(svc.updateTicket).not.toHaveBeenCalled();
  });

  test('an update without company, contract or queue is unchanged (no ticket read)', async () => {
    const w = world();
    const svc = fakeService(w);
    const r = await handler(svc).callTool('autotask_update_ticket', { ticketId: 100, priority: 2 });
    expect(svc.getTicket).not.toHaveBeenCalled();
    expect(svc.updateTicket).toHaveBeenCalledWith(100, { priority: 2 });
    expect(parse(r).message).toBe('Successfully updated ticket 100');
  });

  test('the schema advertises companyID, contractID and queueID, and the default contract rule', () => {
    const t = TOOL_DEFINITIONS.find(d => d.name === 'autotask_update_ticket')!;
    const props = t.inputSchema.properties as Record<string, any>;
    expect(props.companyID.type).toBe('number');
    expect(props.contractID.type).toEqual(['number', 'null']);
    expect(props.queueID.type).toEqual(['number', 'null']);
    expect(t.description).toContain('default contract');
  });
});

describe('autotask_get_company_default_contract', () => {
  test('names the default contract, or says there is none', async () => {
    const w = world();
    const h = handler(fakeService(w));
    const yes = parse(await h.callTool('autotask_get_company_default_contract', { companyID: 2 }));
    expect(yes.data.defaultContract).toEqual({ id: 601, contractName: 'New Co Managed Services' });
    expect(yes.data.contractOnMove).toBe('New Co Managed Services (ID 601), the default contract of Example New Pty Ltd');
    expect(yes.data.activeContracts.map((c: any) => c.id)).toEqual([601, 602]);
    const no = parse(await h.callTool('autotask_get_company_default_contract', { companyID: 3 }));
    expect(no.data.defaultContract).toBeNull();
    expect(no.data.contractOnMove).toBe('no contract: Example Nodefault Pty Ltd has no default contract');
  });
});

describe('Feature B: autotask_merge_ticket', () => {
  test('happy path: notes, attachments, marker note and Complete, all in one call', async () => {
    const w = world();
    w.tickets[100].companyID = 2; w.tickets[100].contractID = 601; w.tickets[100].contactID = 80;
    const svc = fakeService(w);
    const r = await handler(svc).callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200 });
    expect(r.isError).toBeFalsy();
    const body = parse(r);
    expect(body.message).toContain('Merged T20990101.0001 into T20990101.0002');
    expect(body.message).toContain('not an Autotask merge');
    // No company move needed.
    expect(svc.updateTicket).toHaveBeenCalledTimes(1);
    expect(svc.updateTicket).toHaveBeenCalledWith(100, { status: COMPLETE });

    const merged = w.notes[200]!;
    expect(merged).toHaveLength(1);
    expect(merged[0].title).toBe('Merged from T20990101.0001: Printer offline');
    expect(merged[0].noteType).toBe(3);   // tenant default note type
    expect(merged[0].publish).toBe(2);    // "Internal Only"
    expect(merged[0].description).toMatch(/^Merged from T20990101\.0001: Printer offline\n/);
    expect(merged[0].description).toContain('The printer on level 2 is offline.');
    expect(merged[0].description).toContain('--- Called user | Tech One, 2099-01-01 03:00 UTC ---\nUser says it shows an error.');
    expect(merged[0].description).toContain('--- Customer reply | Alex Old, 2099-01-01 04:00 UTC ---');

    const marker = w.notes[100]!.find(n => n.title === 'Merged into T20990101.0002');
    expect(marker).toBeDefined();
    expect(w.tickets[100].status).toBe(COMPLETE);
  });

  test('attachment copy: files copied with their visibility, links and oversized files skipped and reported', async () => {
    const w = world();
    const svc = fakeService(w);
    const r = await handler(svc).callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200 });
    const body = parse(r);
    expect(svc.createTicketAttachment).toHaveBeenCalledTimes(1);
    expect(svc.createTicketAttachment).toHaveBeenCalledWith(200, {
      title: 'error.png (from T20990101.0001 #3001)', fullPath: 'error.png', data: w.attachmentData[3001], contentType: 'image/png', publish: 1,
    });
    // The oversized file is never downloaded.
    expect(svc.getTicketAttachment).toHaveBeenCalledTimes(1);
    expect(body.message).toContain('Attachment "Vendor KB" not copied: a link (URL), not a file.');
    expect(body.message).toContain(`Attachment "dump.zip" not copied: ${MAX_ATTACHMENT_BYTES + 1} bytes, over Autotask's`);
  });

  test('an unrelated file of the same name and size on the target does not stop the copy', async () => {
    const w = world();
    w.attachments[200] = [{ id: 4001, ticketID: 200, title: 'error.png', fullPath: 'error.png', attachmentType: 'FILE_ATTACHMENT', fileSize: 4 }];
    const svc = fakeService(w);
    await handler(svc).callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200 });
    expect(svc.createTicketAttachment).toHaveBeenCalledTimes(1);
    expect(w.attachments[200]!.map(a => a.title)).toEqual(['error.png', 'error.png (from T20990101.0001 #3001)']);
  });

  test('a full page of notes or attachments (the list may be cut short) is refused', async () => {
    for (const which of ['source notes', 'target notes', 'source attachments', 'target attachments']) {
      const w = world();
      const many = (tid: number) => Array.from({ length: 500 }, (_, i) => ({ id: 10000 + i, ticketID: tid, title: `n${i}`, description: 'x' }));
      if (which === 'source notes') w.notes[100] = many(100);
      if (which === 'target notes') w.notes[200] = many(200);
      if (which === 'source attachments') w.attachments[100] = many(100).map(a => ({ ...a, attachmentType: 'URL' }));
      if (which === 'target attachments') w.attachments[200] = many(200);
      const svc = fakeService(w);
      const r = await handler(svc).callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200 });
      expect(r.isError).toBe(true);
      expect(parse(r).error).toContain('500 or more');
      expect(svc.updateTicket).not.toHaveBeenCalled();
      expect(svc.createTicketNote).not.toHaveBeenCalled();
    }
  });

  test('company move: the source moves to the target\'s company with its default contract first', async () => {
    const w = world();
    const svc = fakeService(w);
    const r = await handler(svc).callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200 });
    expect(r.isError).toBeFalsy();
    expect(svc.updateTicket.mock.calls[0]).toEqual([100, { companyID: 2, contractID: 601, contactID: null }]);
    expect(svc.updateTicket.mock.calls[1]).toEqual([100, { status: COMPLETE }]);
    // The move happens before any note is written.
    expect(svc.updateTicket.mock.invocationCallOrder[0]).toBeLessThan(svc.createTicketNote.mock.invocationCallOrder[0]!);
    expect(parse(r).message).toContain('Company: Example Old Pty Ltd (ID 1) → Example New Pty Ltd (ID 2).');
  });

  test('Problem and Change Request tickets are refused before anything is written', async () => {
    for (const ticketType of [3, 4]) {
      const w = world();
      w.tickets[200].ticketType = ticketType;
      const svc = fakeService(w);
      const r = await handler(svc).callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200 });
      expect(r.isError).toBe(true);
      expect(parse(r).error).toContain(ticketType === 3 ? 'is a Problem ticket' : 'is a Change Request ticket');
      expect(svc.updateTicket).not.toHaveBeenCalled();
      expect(svc.createTicketNote).not.toHaveBeenCalled();
      expect(svc.createTicketAttachment).not.toHaveBeenCalled();
    }
  });

  test('the same ticket twice, a missing ticket and an already Complete source are refused', async () => {
    const w = world();
    const h = handler(fakeService(w));
    expect(parse(await h.callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 100 })).error).toContain('same ticket');
    expect(parse(await h.callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 404 })).error).toContain('Target ticket 404 was not found');
    w.tickets[100].status = COMPLETE;
    expect(parse(await h.callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200 })).error).toContain('already Complete');
  });

  test('partial failure: an error result that says what was done and what failed, and the source stays open', async () => {
    const w = world();
    const svc = fakeService(w, { createTicketAttachment: jest.fn().mockRejectedValue(new Error('HTTP 500: boom')) });
    const r = await handler(svc).callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200 });
    expect(r.isError).toBe(true);
    const err = parse(r).error as string;
    expect(err).toContain('did NOT complete');
    expect(err).toContain('Done: Moved T20990101.0001');
    expect(err).toContain('Added note "Merged from T20990101.0001: Printer offline"');
    expect(err).toContain('Failed: Copying attachment "error.png" failed: HTTP 500: boom');
    expect(err).toContain('was not closed');
    expect(w.tickets[100].status).toBe(1);
    expect(w.notes[100]!.some(n => String(n.title).startsWith('Merged into'))).toBe(false);
  });

  test('a re-run after a partial failure does not duplicate the target note or copied files', async () => {
    const w = world();
    const failing = fakeService(w, { createTicketNote: jest.fn() });
    // First run: everything up to the source marker note works, then that note fails.
    let call = 0;
    const realCreate = fakeService(w).createTicketNote;
    failing.createTicketNote.mockImplementation(async (id: number, n: any) => {
      call++;
      if (id === 100) throw new Error('HTTP 500: note refused');
      return realCreate(id, n);
    });
    const first = await handler(failing).callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200 });
    expect(first.isError).toBe(true);
    expect(w.notes[200]).toHaveLength(1);
    expect(w.attachments[200]).toHaveLength(1);
    expect(call).toBe(2);

    const svc = fakeService(w);
    const second = await handler(svc).callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200 });
    expect(second.isError).toBeFalsy();
    expect(w.notes[200]).toHaveLength(1);
    expect(w.attachments[200]).toHaveLength(1);
    expect(svc.createTicketNote).toHaveBeenCalledTimes(1);
    expect(svc.createTicketNote).toHaveBeenCalledWith(100, expect.objectContaining({ title: 'Merged into T20990101.0002' }));
    const msg = parse(second).message as string;
    expect(msg).toContain('is already on T20990101.0002');
    expect(w.tickets[100].status).toBe(COMPLETE);

    // A third run on the now Complete, marked source is a no-op, not a refusal.
    const svc3 = fakeService(w);
    const third = await handler(svc3).callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200 });
    expect(third.isError).toBeFalsy();
    expect(svc3.createTicketNote).not.toHaveBeenCalled();
    expect(svc3.updateTicket).not.toHaveBeenCalled();
    expect(svc3.createTicketAttachment).not.toHaveBeenCalled();
  });

  test('long content is split over several notes within the note length limit', async () => {
    const w = world();
    w.notes[100] = Array.from({ length: 5 }, (_, i) => ({
      id: 2000 + i, ticketID: 100, title: `Note ${i}`, description: 'x'.repeat(9000), creatorResourceID: 30, createDateTime: `2099-01-0${i + 2}T00:00:00Z`,
    }));
    await handler(fakeService(w)).callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200 });
    const parts = w.notes[200]!;
    expect(parts.length).toBe(2);
    expect(parts.map(p => p.title)).toEqual([
      'Merged from T20990101.0001 (part 1 of 2): Printer offline',
      'Merged from T20990101.0001 (part 2 of 2): Printer offline',
    ]);
    for (const p of parts) expect(p.description.length).toBeLessThanOrEqual(32000);
  });

  test('without a default note type or an internal visibility, the caller must pass them', async () => {
    const w = world();
    const svc = fakeService(w, {
      getFieldInfo: jest.fn(async (e: string) => (e === 'Tickets' ? TICKET_FIELDS : e === 'TicketNotes'
        ? NOTE_FIELDS.map(f => ({ ...f, picklistValues: f.picklistValues?.map(v => ({ value: v.value, label: v.label === 'Internal Only' ? 'Everyone' : v.label })) }))
        : [])),
    });
    const r = await handler(svc).callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200 });
    expect(parse(r).error).toContain('Pass noteType');
    expect(parse(r).error).toContain('Pass publish');
    const ok = await handler(svc).callTool('autotask_merge_ticket', { sourceTicketId: 100, targetTicketId: 200, noteType: 1, publish: 2 });
    expect(ok.isError).toBeFalsy();
  });
});

describe('autotask_preview_ticket_merge', () => {
  test('describes the merge, including the contract the move sets, and changes nothing', async () => {
    const w = world();
    const svc = fakeService(w);
    const body = parse(await handler(svc).callTool('autotask_preview_ticket_merge', { sourceTicketId: 100, targetTicketId: 200 }));
    expect(body.data.canMerge).toBe(true);
    expect(body.data.source).toBe('T20990101.0001: Printer offline');
    expect(body.data.targetCompany).toBe('Example New Pty Ltd');
    expect(body.data.companyMove).toBe('T20990101.0001 moves from Example Old Pty Ltd to Example New Pty Ltd');
    expect(body.data.contractAfterMove).toBe('New Co Managed Services (ID 601) (the default contract of Example New Pty Ltd)');
    expect(body.data.attachments).toContain('1 to copy, 2 skipped');
    expect(svc.updateTicket).not.toHaveBeenCalled();
    expect(svc.createTicketNote).not.toHaveBeenCalled();
    expect(svc.createTicketAttachment).not.toHaveBeenCalled();
  });

  test('reports a refusal as canMerge false with the reason', async () => {
    const w = world();
    w.tickets[100].ticketType = 3;
    const body = parse(await handler(fakeService(w)).callTool('autotask_preview_ticket_merge', { sourceTicketId: 100, targetTicketId: 200 }));
    expect(body.data.canMerge).toBe(false);
    expect(body.data.blockers[0]).toContain('Problem');
  });
});

describe('tool registration', () => {
  test('the merge and preview tools are defined, categorised and say this is not a native merge', () => {
    const merge = TOOL_DEFINITIONS.find(d => d.name === 'autotask_merge_ticket')!;
    expect(merge.description).toContain('NOT Autotask\'s native merge');
    expect(merge.inputSchema.required).toEqual(['sourceTicketId', 'targetTicketId']);
    expect(merge.annotations?.readOnlyHint).toBe(false);
    expect(TOOL_DEFINITIONS.find(d => d.name === 'autotask_preview_ticket_merge')!.annotations?.readOnlyHint).toBe(true);
    expect(TOOL_DEFINITIONS.find(d => d.name === 'autotask_get_company_default_contract')!.annotations?.readOnlyHint).toBe(true);
    expect(TOOL_CATEGORIES.tickets.tools).toEqual(expect.arrayContaining(['autotask_merge_ticket', 'autotask_preview_ticket_merge']));
    expect(TOOL_CATEGORIES.financial.tools).toContain('autotask_get_company_default_contract');
  });
});
