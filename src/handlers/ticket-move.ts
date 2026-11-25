// Company / contract / queue changes on a ticket, and a merge-equivalent.
//
// Autotask's REST API has no ticket merge (Tickets supports only query, get,
// create, PATCH and PUT), and unlike the web UI a PATCH that changes a
// ticket's company does not pick a contract for it. This module plans both
// changes with reads only, so a plan can be previewed (and shown on an
// approval card) before anything is written, and then carries them out.
//
// Contract rule (what the Autotask UI does): when a ticket's company changes,
// its contract becomes the new company's default contract (the active contract
// with isDefaultContract = true; Autotask allows one per company). A company
// with no default contract leaves the ticket without a contract. An explicit
// contractID always wins and must belong to the ticket's (new) company.

import type { AutotaskService } from '../services/autotask.service.js';
import { AUTOTASK_MAX_PAGE_SIZE } from '../services/autotask-http.js';
import type { FieldInfo, PicklistCache, PicklistValue } from '../services/picklist.cache.js';
import type { AutotaskContract, AutotaskTicket, AutotaskTicketAttachment, AutotaskTicketNote } from '../types/autotask.js';

export type TicketOpsService = Pick<
  AutotaskService,
  | 'getTicket'
  | 'getCompany'
  | 'getContract'
  | 'searchContracts'
  | 'getContact'
  | 'getConfigurationItem'
  | 'getResource'
  | 'updateTicket'
  | 'searchTicketNotes'
  | 'createTicketNote'
  | 'searchTicketAttachments'
  | 'getTicketAttachment'
  | 'createTicketAttachment'
>;

export type TicketOpsPicklists = Pick<PicklistCache, 'getFields'>;

/** Autotask's own limits when field info does not say (TicketNotes). */
const DEFAULT_NOTE_DESCRIPTION_MAX = 32000;
const DEFAULT_NOTE_TITLE_MAX = 250;
/** Autotask's ticket attachment limit, as enforced by createTicketAttachment. */
export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
/**
 * Notes and attachments are read with one child query, which returns at most
 * one page (AUTOTASK_MAX_PAGE_SIZE records). A full page means the list may be
 * cut short, so the merge is refused rather than copying part of a ticket.
 */
const MAX_CHILD_RECORDS = AUTOTASK_MAX_PAGE_SIZE;
/** TicketAttachments title length. */
const ATTACHMENT_TITLE_MAX = 255;
/** Autotask's system ticket types that cannot be merged. */
const PROBLEM_TICKET_TYPE = 3;
const CHANGE_REQUEST_TICKET_TYPE = 4;
const ACTIVE_CONTRACT_STATUS = 1;

export interface NamedRef {
  id: number | null;
  name: string;
}

export interface TicketChangeRequest {
  companyID?: number | undefined;
  contractID?: number | null | undefined;
  queueID?: number | null | undefined;
  contactID?: number | null | undefined;
}

export interface TicketChangePlan {
  /** Fields to add to the PATCH body (only what changes). */
  payload: Record<string, any>;
  company?: { from: NamedRef; to: NamedRef };
  contract?: { from: NamedRef; to: NamedRef; reason: string };
  queue?: { from: NamedRef; to: NamedRef };
  contact?: { from: NamedRef; to: NamedRef; reason: string };
  /** Other fields cleared because they belong to the old company or contract. */
  cleared: string[];
  /** Plain-words lines, one per change. */
  lines: string[];
}

export class TicketOpsError extends Error {}

function personName(p: { firstName?: string; lastName?: string } | null | undefined): string | undefined {
  if (!p) return undefined;
  const name = [p.firstName, p.lastName].filter(x => typeof x === 'string' && x.trim()).join(' ').trim();
  return name || undefined;
}

function refText(r: NamedRef): string {
  return r.id === null ? r.name : `${r.name} (ID ${r.id})`;
}

const NONE: NamedRef = { id: null, name: 'none' };

function picklistLabel(fields: FieldInfo[] | null, field: string, value: unknown): string | undefined {
  if (!fields || value === undefined || value === null) return undefined;
  return fields
    .find(f => f.name.toLowerCase() === field.toLowerCase())
    ?.picklistValues?.find(v => String(v.value) === String(value))?.label;
}

function picklist(fields: FieldInfo[] | null, field: string): PicklistValue[] {
  if (!fields) return [];
  return fields.find(f => f.name.toLowerCase() === field.toLowerCase())?.picklistValues ?? [];
}

export class TicketOps {
  private resourceNames = new Map<number, string>();
  private contactNames = new Map<number, string>();

  constructor(private readonly s: TicketOpsService, private readonly picklists: TicketOpsPicklists) {}

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  private async fields(entity: string): Promise<FieldInfo[] | null> {
    try {
      return await this.picklists.getFields(entity);
    } catch {
      return null;
    }
  }

  async loadTicket(id: number, what = 'Ticket'): Promise<AutotaskTicket> {
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
      throw new TicketOpsError(`${what} ID must be a positive integer.`);
    }
    const t = await this.s.getTicket(id, true);
    if (!t) throw new TicketOpsError(`${what} ${id} was not found.`);
    return t;
  }

  async companyRef(id: number | undefined | null): Promise<NamedRef> {
    if (id === undefined || id === null) return NONE;
    try {
      const c = await this.s.getCompany(id);
      return { id, name: c?.companyName || `company ${id}` };
    } catch {
      return { id, name: `company ${id}` };
    }
  }

  async contractRef(id: number | undefined | null): Promise<NamedRef> {
    if (id === undefined || id === null) return NONE;
    try {
      const c = await this.s.getContract(id);
      return { id, name: c?.contractName || `contract ${id}` };
    } catch {
      return { id, name: `contract ${id}` };
    }
  }

  async contactName(id: number): Promise<string> {
    const cached = this.contactNames.get(id);
    if (cached) return cached;
    let name = `contact ${id}`;
    try {
      name = personName(await this.s.getContact(id)) ?? name;
    } catch { /* keep the ID */ }
    this.contactNames.set(id, name);
    return name;
  }

  async resourceName(id: number): Promise<string> {
    const cached = this.resourceNames.get(id);
    if (cached) return cached;
    let name = `resource ${id}`;
    try {
      name = personName(await this.s.getResource(id)) ?? name;
    } catch { /* keep the ID */ }
    this.resourceNames.set(id, name);
    return name;
  }

  /**
   * The company's default contract: the active contract with
   * isDefaultContract = true. Autotask allows one per company; should a
   * tenant ever return more, the lowest ID is used. Null when there is none.
   */
  async defaultContract(companyId: number): Promise<AutotaskContract | null> {
    const rows = await this.s.searchContracts({
      companyID: companyId,
      status: ACTIVE_CONTRACT_STATUS,
      filter: { isDefaultContract: true },
      pageSize: 50,
    } as any);
    const defaults = rows
      .filter(c => c && c.isDefaultContract !== false && c.companyID === companyId)
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    return defaults[0] ?? null;
  }

  /** Active contracts of a company (for previews), default first. */
  async activeContracts(companyId: number): Promise<AutotaskContract[]> {
    const rows = await this.s.searchContracts({
      companyID: companyId,
      status: ACTIVE_CONTRACT_STATUS,
      pageSize: 200,
    } as any);
    return rows
      .filter(c => c && c.companyID === companyId)
      .sort((a, b) => Number(!!b.isDefaultContract) - Number(!!a.isDefaultContract) || (a.id ?? 0) - (b.id ?? 0));
  }

  /**
   * What the ticket's contract becomes when it moves to `companyId` and no
   * contractID is given, in plain words.
   */
  async contractOnMove(companyId: number, companyName: string): Promise<{ to: NamedRef; reason: string }> {
    const d = await this.defaultContract(companyId);
    if (d && typeof d.id === 'number') {
      return {
        to: { id: d.id, name: d.contractName || `contract ${d.id}` },
        reason: `the default contract of ${companyName}`,
      };
    }
    return { to: NONE, reason: `${companyName} has no default contract, so the ticket has no contract` };
  }

  // ---------------------------------------------------------------------------
  // Feature A: company, contract and queue on a ticket
  // ---------------------------------------------------------------------------

  /**
   * Plan a company/contract/queue/contact change on `ticket` (reads only).
   * Throws TicketOpsError for a change Autotask would refuse or that cannot
   * be made safely.
   */
  async planTicketChange(ticket: AutotaskTicket, req: TicketChangeRequest): Promise<TicketChangePlan> {
    const plan: TicketChangePlan = { payload: {}, cleared: [], lines: [] };
    const oldCompanyId = ticket.companyID;
    const companyChanging = req.companyID !== undefined && req.companyID !== oldCompanyId;
    const companyId = companyChanging ? (req.companyID as number) : oldCompanyId;

    if (req.companyID !== undefined) {
      if (typeof req.companyID !== 'number' || !Number.isInteger(req.companyID) || req.companyID < 0) {
        throw new TicketOpsError('companyID must be a non-negative integer.');
      }
    }

    let newCompany: NamedRef | undefined;
    if (companyChanging) {
      const company = await this.s.getCompany(companyId as number);
      if (!company) throw new TicketOpsError(`Company ${companyId} was not found.`);
      if (company.isActive === false) {
        throw new TicketOpsError(`Company ${company.companyName ?? companyId} (ID ${companyId}) is inactive; Autotask does not allow tickets on an inactive company.`);
      }
      if (ticket.projectID !== undefined && ticket.projectID !== null) {
        throw new TicketOpsError(`Ticket ${ticket.ticketNumber ?? ticket.id} belongs to project ${ticket.projectID}, which belongs to its current company. Remove it from the project before moving it to another company.`);
      }
      newCompany = { id: companyId as number, name: company.companyName || `company ${companyId}` };
      const oldCompany = await this.companyRef(oldCompanyId);
      plan.payload.companyID = companyId;
      plan.company = { from: oldCompany, to: newCompany };
      plan.lines.push(`Company: ${refText(oldCompany)} → ${refText(newCompany)}.`);
    }
    const companyName = newCompany?.name ?? (await this.companyRef(companyId)).name;

    // Contract
    const oldContractId = ticket.contractID ?? null;
    let newContract: { to: NamedRef; reason: string } | undefined;
    if (req.contractID !== undefined) {
      if (req.contractID === null) {
        newContract = { to: NONE, reason: 'removed as requested' };
      } else {
        if (typeof req.contractID !== 'number' || !Number.isInteger(req.contractID) || req.contractID <= 0) {
          throw new TicketOpsError('contractID must be a positive integer or null.');
        }
        const c = await this.s.getContract(req.contractID);
        if (!c) throw new TicketOpsError(`Contract ${req.contractID} was not found.`);
        if (c.companyID !== companyId) {
          const owner = await this.companyRef(c.companyID);
          throw new TicketOpsError(
            `Contract ${c.contractName ?? req.contractID} (ID ${req.contractID}) belongs to ${refText(owner)}, not to ${companyName} (ID ${companyId}). ` +
            'Pass a contract of the ticket\'s company, or leave contractID out to use that company\'s default contract.');
        }
        if (c.status !== undefined && c.status !== null && Number(c.status) !== ACTIVE_CONTRACT_STATUS) {
          throw new TicketOpsError(`Contract ${c.contractName ?? req.contractID} (ID ${req.contractID}) is not active.`);
        }
        newContract = { to: { id: req.contractID, name: c.contractName || `contract ${req.contractID}` }, reason: 'as requested' };
      }
    } else if (companyChanging) {
      newContract = await this.contractOnMove(companyId as number, companyName);
    }
    if (newContract && (newContract.to.id !== oldContractId || companyChanging)) {
      const from = await this.contractRef(oldContractId);
      plan.contract = { from, to: newContract.to, reason: newContract.reason };
      if (newContract.to.id !== oldContractId) {
        plan.payload.contractID = newContract.to.id;
        // Service and bundle links belong to the old contract.
        for (const f of ['contractServiceID', 'contractServiceBundleID']) {
          if (ticket[f] !== undefined && ticket[f] !== null) {
            plan.payload[f] = null;
            plan.cleared.push(f);
          }
        }
        plan.lines.push(newContract.to.id === null
          ? `Contract: ${refText(from)} → no contract (${newContract.reason}).`
          : `Contract: ${refText(from)} → ${refText(newContract.to)} (${newContract.reason}).`);
      } else {
        plan.lines.push(`Contract: stays ${refText(from)} (${newContract.reason}).`);
      }
    }

    // Contact, configuration item and location belong to a company.
    if (companyChanging) {
      const oldContactId = ticket.contactID ?? null;
      if (req.contactID !== undefined && req.contactID !== null) {
        const c = await this.s.getContact(req.contactID);
        if (!c) throw new TicketOpsError(`Contact ${req.contactID} was not found.`);
        if (c.companyID !== companyId) {
          throw new TicketOpsError(`Contact ${personName(c) ?? req.contactID} (ID ${req.contactID}) does not belong to ${companyName} (ID ${companyId}).`);
        }
        const to = { id: req.contactID, name: personName(c) ?? `contact ${req.contactID}` };
        const from = oldContactId === null ? NONE : { id: oldContactId, name: await this.contactName(oldContactId) };
        plan.payload.contactID = req.contactID;
        plan.contact = { from, to, reason: 'as requested' };
        plan.lines.push(`Contact: ${refText(from)} → ${refText(to)}.`);
      } else if (req.contactID === null) {
        if (oldContactId !== null) {
          const from = { id: oldContactId, name: await this.contactName(oldContactId) };
          plan.payload.contactID = null;
          plan.contact = { from, to: NONE, reason: 'removed as requested' };
          plan.lines.push(`Contact: ${refText(from)} removed, as requested.`);
        }
      } else if (oldContactId !== null) {
        const c = await this.s.getContact(oldContactId);
        if (!c || c.companyID !== companyId) {
          const from = { id: oldContactId, name: personName(c) ?? `contact ${oldContactId}` };
          const oldName = plan.company?.from.name ?? 'the previous company';
          plan.payload.contactID = null;
          plan.contact = { from, to: NONE, reason: `belongs to ${oldName}` };
          plan.lines.push(`Contact: ${refText(from)} removed from the ticket: the contact belongs to ${oldName}. Pass contactID to set a contact of ${companyName}.`);
        }
      }

      if (ticket.configurationItemID !== undefined && ticket.configurationItemID !== null) {
        let ciCompany: number | undefined;
        try {
          ciCompany = (await this.s.getConfigurationItem(ticket.configurationItemID))?.companyID;
        } catch { /* treat as not the new company's */ }
        if (ciCompany !== companyId) {
          plan.payload.configurationItemID = null;
          plan.cleared.push('configurationItemID');
          plan.lines.push(`Configuration item ${ticket.configurationItemID} removed: it belongs to another company.`);
        }
      }
      if (ticket.companyLocationID !== undefined && ticket.companyLocationID !== null) {
        plan.payload.companyLocationID = null;
        plan.cleared.push('companyLocationID');
        plan.lines.push(`Company location ${ticket.companyLocationID} removed: it belongs to the previous company.`);
      }
    }

    // Queue
    if (req.queueID !== undefined && req.queueID !== (ticket.queueID ?? null)) {
      const fields = await this.fields('Tickets');
      const queues = picklist(fields, 'queueID');
      let to: NamedRef = NONE;
      if (req.queueID !== null) {
        if (typeof req.queueID !== 'number' || !Number.isInteger(req.queueID) || req.queueID <= 0) {
          throw new TicketOpsError('queueID must be a positive integer or null.');
        }
        const q = queues.find(v => String(v.value) === String(req.queueID));
        if (queues.length > 0 && (!q || q.isActive === false)) {
          throw new TicketOpsError(`Queue ${req.queueID} is not an active queue. Use autotask_list_queues to find valid IDs.`);
        }
        to = { id: req.queueID, name: q?.label ?? `queue ${req.queueID}` };
      }
      const oldQ = ticket.queueID ?? null;
      const from: NamedRef = oldQ === null ? NONE : { id: oldQ, name: picklistLabel(fields, 'queueID', oldQ) ?? `queue ${oldQ}` };
      plan.payload.queueID = req.queueID;
      plan.queue = { from, to };
      plan.lines.push(`Queue: ${refText(from)} → ${to.id === null ? 'no queue' : refText(to)}.`);
    }

    return plan;
  }

  // ---------------------------------------------------------------------------
  // Feature B: merge-equivalent
  // ---------------------------------------------------------------------------

  private noteLimits(fields: FieldInfo[] | null): { description: number; title: number } {
    const len = (name: string, fallback: number) => {
      const n = fields?.find(f => f.name.toLowerCase() === name)?.length;
      return typeof n === 'number' && n > 0 ? n : fallback;
    };
    return { description: len('description', DEFAULT_NOTE_DESCRIPTION_MAX), title: len('title', DEFAULT_NOTE_TITLE_MAX) };
  }

  /** noteType and publish for the merge notes: given, or the tenant's default / internal-only value. */
  private resolveNoteSettings(
    fields: FieldInfo[] | null,
    given: { noteType?: number | undefined; publish?: number | undefined },
  ): { noteType?: number; publish?: number; problems: string[] } {
    const problems: string[] = [];
    let noteType = given.noteType;
    if (noteType === undefined) {
      const types = picklist(fields, 'noteType').filter(v => v.isActive !== false);
      const d = types.find(v => v.isDefaultValue);
      if (d) noteType = Number(d.value);
      else problems.push('Pass noteType: this Autotask has no default ticket note type (see autotask_get_field_info, entityType "TicketNotes", fieldName "noteType").');
    }
    let publish = given.publish;
    if (publish === undefined) {
      const values = picklist(fields, 'publish').filter(v => v.isActive !== false);
      const internal = values.find(v => /^internal/i.test(v.label.trim()));
      if (internal) publish = Number(internal.value);
      else problems.push('Pass publish: no "Internal ..." note visibility was found (see autotask_get_field_info, entityType "TicketNotes", fieldName "publish").');
    }
    const out: { noteType?: number; publish?: number; problems: string[] } = { problems };
    if (noteType !== undefined) out.noteType = noteType;
    if (publish !== undefined) out.publish = publish;
    return out;
  }

  /** Header (note title prefix) that marks the merged content on the target. */
  static mergedFromPrefix(sourceNumber: string): string {
    return `Merged from ${sourceNumber}`;
  }

  static mergedIntoTitle(targetNumber: string): string {
    return `Merged into ${targetNumber}`;
  }

  private static when(iso: unknown): string {
    if (typeof iso !== 'string' || !iso) return 'date unknown';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  }

  private async noteAuthor(n: AutotaskTicketNote): Promise<string> {
    const rid = n.creatorResourceID ?? n.createdByResourceID;
    if (typeof rid === 'number') return this.resourceName(rid);
    const cid = n.createdByContactID;
    if (typeof cid === 'number') return this.contactName(cid);
    return 'author unknown';
  }

  /** Split text blocks into note bodies of at most `limit` characters. */
  static pack(blocks: string[], limit: number): string[] {
    const parts: string[] = [];
    let cur = '';
    const flush = () => { if (cur) { parts.push(cur); cur = ''; } };
    for (const block of blocks) {
      const sep = cur ? '\n\n' : '';
      if (cur.length + sep.length + block.length <= limit) {
        cur += sep + block;
        continue;
      }
      flush();
      if (block.length <= limit) {
        cur = block;
        continue;
      }
      for (let i = 0; i < block.length; i += limit) parts.push(block.slice(i, i + limit));
    }
    flush();
    return parts;
  }

  /** Plan a merge (reads only). Never throws for a merge-specific refusal: see `blockers`. */
  async planMerge(sourceTicketId: number, targetTicketId: number, opts: { noteType?: number; publish?: number } = {}): Promise<MergePlan> {
    if (sourceTicketId === targetTicketId) {
      throw new TicketOpsError('sourceTicketId and targetTicketId are the same ticket.');
    }
    const [source, target] = await Promise.all([
      this.loadTicket(sourceTicketId, 'Source ticket'),
      this.loadTicket(targetTicketId, 'Target ticket'),
    ]);
    const [ticketFields, noteFields] = await Promise.all([this.fields('Tickets'), this.fields('TicketNotes')]);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const sourceNumber = source.ticketNumber ?? `ticket ${source.id}`;
    const targetNumber = target.ticketNumber ?? `ticket ${target.id}`;

    for (const [label, t] of [['Source', source], ['Target', target]] as const) {
      const typeLabel = picklistLabel(ticketFields, 'ticketType', t.ticketType);
      const isProblem = t.ticketType === PROBLEM_TICKET_TYPE || /^problem$/i.test(typeLabel ?? '');
      const isChange = t.ticketType === CHANGE_REQUEST_TICKET_TYPE || /^change request$/i.test(typeLabel ?? '');
      if (isProblem || isChange) {
        blockers.push(`${label} ticket ${t.ticketNumber ?? t.id} is a ${isProblem ? 'Problem' : 'Change Request'} ticket; Autotask does not allow merging Problem or Change Request tickets.`);
      }
    }

    const statuses = picklist(ticketFields, 'status');
    const complete = statuses.find(v => v.label.trim().toLowerCase() === 'complete');
    const completeStatus = complete ? Number(complete.value) : undefined;
    if (completeStatus === undefined) {
      blockers.push('The "Complete" ticket status could not be found in the ticket status list, so the source ticket could not be closed.');
    }

    const [sourceNotesRaw, targetNotes, sourceAttachments, targetAttachments] = await Promise.all([
      this.s.searchTicketNotes(source.id as number, { pageSize: MAX_CHILD_RECORDS }),
      this.s.searchTicketNotes(target.id as number, { pageSize: MAX_CHILD_RECORDS }),
      this.s.searchTicketAttachments(source.id as number, { pageSize: MAX_CHILD_RECORDS }),
      this.s.searchTicketAttachments(target.id as number, { pageSize: MAX_CHILD_RECORDS }),
    ]);
    for (const [what, rows] of [
      [`notes on ${sourceNumber}`, sourceNotesRaw], [`notes on ${targetNumber}`, targetNotes],
      [`attachments on ${sourceNumber}`, sourceAttachments], [`attachments on ${targetNumber}`, targetAttachments],
    ] as const) {
      if (rows.length >= MAX_CHILD_RECORDS) {
        blockers.push(`There are ${MAX_CHILD_RECORDS} or more ${what}, more than one read returns, so the merge could not be checked as complete; merge these tickets by hand.`);
      }
    }

    const intoTitle = TicketOps.mergedIntoTitle(targetNumber);
    const alreadyMarked = sourceNotesRaw.some(n => typeof n.title === 'string' && n.title.startsWith(intoTitle));
    const sourceComplete = completeStatus !== undefined && source.status === completeStatus;
    if (sourceComplete && !alreadyMarked) {
      blockers.push(`Source ticket ${sourceNumber} is already Complete. Reopen it first if it really should be merged.`);
    }
    if (completeStatus !== undefined && target.status === completeStatus) {
      warnings.push(`Target ticket ${targetNumber} is Complete.`);
    }

    // Company move (Feature A rules).
    let companyChange: TicketChangePlan | undefined;
    if (source.companyID !== target.companyID) {
      try {
        companyChange = await this.planTicketChange(source, { companyID: target.companyID });
      } catch (e) {
        if (!(e instanceof TicketOpsError)) throw e;
        blockers.push(`Moving the source ticket to the target's company: ${e.message}`);
      }
    }

    const settings = this.resolveNoteSettings(noteFields, opts);
    blockers.push(...settings.problems);

    // Target note content: the source description, then its notes, oldest first.
    const sourceNotes = sourceNotesRaw
      .filter(n => !(typeof n.title === 'string' && n.title.startsWith('Merged into ')))
      .sort((a, b) => String(a.createDateTime ?? a.createDate ?? '').localeCompare(String(b.createDateTime ?? b.createDate ?? '')));
    const limits = this.noteLimits(noteFields);
    const prefix = TicketOps.mergedFromPrefix(sourceNumber);
    const header = `${prefix}: ${source.title ?? ''}`.trim();
    const sourceCompany = await this.companyRef(source.companyID);
    const blocks: string[] = [
      `${header}\nSource ticket ${sourceNumber} (ID ${source.id}), ${sourceCompany.name}, created ${TicketOps.when(source.createDate)}.` +
      '\nCopied by autotask_merge_ticket: this is not an Autotask merge, so Autotask shows no merge link between the tickets.',
      `Description:\n${(source.description ?? '').trim() || '(none)'}`,
    ];
    for (const n of sourceNotes) {
      const author = await this.noteAuthor(n);
      const title = typeof n.title === 'string' && n.title.trim() ? n.title.trim() : 'Note';
      blocks.push(`--- ${title} | ${author}, ${TicketOps.when(n.createDateTime ?? n.createDate)} ---\n${(n.description ?? '').trim()}`);
    }
    const bodies = TicketOps.pack(blocks, limits.description);
    const notes: PlannedNote[] = bodies.map((body, i) => {
      const titleHead = bodies.length === 1 ? prefix : `${prefix} (part ${i + 1} of ${bodies.length})`;
      const full = `${titleHead}: ${source.title ?? ''}`.trim();
      return { title: full.length > limits.title ? full.slice(0, limits.title - 3) + '...' : full, titleHead, description: body };
    });
    const existingTitles = targetNotes.map(n => (typeof n.title === 'string' ? n.title : ''));
    const singleDone = existingTitles.some(t => t.startsWith(`${prefix}:`));
    for (const n of notes) {
      n.exists = singleDone || existingTitles.some(t => t.startsWith(`${n.titleHead}:`));
    }

    // Attachments. A copy's title names the source ticket and attachment ID
    // ("error.png (from T... #123)"), so a re-run recognises its own copies and
    // an unrelated file of the same name on the target never stops a copy.
    const targetTitles = new Set(targetAttachments.map(t => String(t.title ?? t.fileName ?? '')));
    const attachments: PlannedAttachment[] = sourceAttachments.map(a => {
      const title = (a.title ?? a.fileName ?? `attachment ${a.id}`) as string;
      const type = typeof a.attachmentType === 'string' ? a.attachmentType.toUpperCase() : 'FILE_ATTACHMENT';
      const size = typeof a.fileSize === 'number' ? a.fileSize : undefined;
      const tag = ` (from ${sourceNumber} #${a.id})`;
      const copyTitle = title.length + tag.length > ATTACHMENT_TITLE_MAX
        ? title.slice(0, Math.max(0, ATTACHMENT_TITLE_MAX - tag.length - 3)) + '...' + tag
        : title + tag;
      const p: PlannedAttachment = { id: a.id as number, title, copyTitle, action: 'copy' };
      if (size !== undefined) p.fileSize = size;
      if (type !== 'FILE_ATTACHMENT') {
        p.action = 'skip';
        p.reason = `a ${type === 'URL' ? 'link (URL)' : type.toLowerCase().replace(/_/g, ' ')}, not a file`;
      } else if (size !== undefined && size > MAX_ATTACHMENT_BYTES) {
        p.action = 'skip';
        p.reason = `${size} bytes, over Autotask's ${MAX_ATTACHMENT_BYTES}-byte attachment limit`;
      } else if (targetTitles.has(copyTitle)) {
        p.action = 'exists';
      }
      return p;
    });

    const plan: MergePlan = {
      source: { id: source.id as number, ticketNumber: sourceNumber, title: source.title ?? '', company: sourceCompany, status: source.status },
      target: { id: target.id as number, ticketNumber: targetNumber, title: target.title ?? '', company: await this.companyRef(target.companyID), status: target.status },
      blockers,
      warnings,
      notes,
      attachments,
      sourceNoteCount: sourceNotes.length,
      sourceAlreadyMarked: alreadyMarked,
      sourceComplete,
    };
    if (companyChange) plan.companyChange = companyChange;
    if (completeStatus !== undefined) plan.completeStatus = completeStatus;
    if (settings.noteType !== undefined) plan.noteType = settings.noteType;
    if (settings.publish !== undefined) plan.publish = settings.publish;
    return plan;
  }

  /** A readable summary of a plan (also used by the preview tool and approval cards). */
  static describePlan(plan: MergePlan): MergePreview {
    const files = plan.attachments.filter(a => a.action === 'copy').length;
    const skipped = plan.attachments.filter(a => a.action === 'skip');
    const present = plan.attachments.filter(a => a.action === 'exists').length;
    const newNotes = plan.notes.filter(n => !n.exists).length;
    const cc = plan.companyChange;
    return {
      canMerge: plan.blockers.length === 0,
      blockers: plan.blockers,
      warnings: plan.warnings,
      source: `${plan.source.ticketNumber}: ${plan.source.title}`,
      sourceCompany: plan.source.company.name,
      target: `${plan.target.ticketNumber}: ${plan.target.title}`,
      targetCompany: plan.target.company.name,
      companyMove: cc?.company
        ? `${plan.source.ticketNumber} moves from ${cc.company.from.name} to ${cc.company.to.name}`
        : 'none (same company)',
      contractAfterMove: cc?.contract
        ? (cc.contract.to.id === null ? `no contract (${cc.contract.reason})` : `${refText(cc.contract.to)} (${cc.contract.reason})`)
        : 'unchanged',
      contactAfterMove: cc?.contact ? `${refText(cc.contact.from)} removed (${cc.contact.reason})` : 'unchanged',
      notesToTarget: plan.notes.length === 0 ? 'none'
        : `${plan.sourceNoteCount} source note(s) and the description in ${plan.notes.length} note(s) on ${plan.target.ticketNumber}` +
          (newNotes < plan.notes.length ? ` (${plan.notes.length - newNotes} already there)` : ''),
      attachments: `${files} to copy` + (present ? `, ${present} already on the target` : '') +
        (skipped.length ? `, ${skipped.length} skipped (${skipped.map(a => `${a.title}: ${a.reason}`).join('; ')})` : ''),
      sourceAfter: `note "${TicketOps.mergedIntoTitle(plan.target.ticketNumber)}" and status Complete`,
      nativeMerge: 'no: this copies the content and closes the source; Autotask shows no merge link',
    };
  }

  /**
   * Carry out a merge plan. Each step is skipped when already done (so a
   * re-run after a partial failure finishes the job without duplicates).
   * The source is closed only when every earlier step succeeded.
   */
  async executeMerge(plan: MergePlan): Promise<MergeOutcome> {
    if (plan.blockers.length) {
      throw new TicketOpsError(`Not merged: ${plan.blockers.join(' ')}`);
    }
    const done: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    const src = plan.source;
    const tgt = plan.target;
    const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
    const finish = (): MergeOutcome => ({ ok: failed.length === 0, done, failed, skipped, plan: TicketOps.describePlan(plan) });

    // 1. Company move
    const cc = plan.companyChange;
    if (cc && Object.keys(cc.payload).length > 0) {
      try {
        await this.s.updateTicket(src.id, cc.payload);
        done.push(`Moved ${src.ticketNumber} to the target's company. ${cc.lines.join(' ')}`);
      } catch (e) {
        failed.push(`Moving ${src.ticketNumber} to ${cc.company?.to.name ?? 'the target company'} failed: ${errText(e)}`);
        return finish();
      }
    }

    // 2. Content notes on the target
    const noteBase = { noteType: plan.noteType as number, publish: plan.publish as number };
    let notesOk = true;
    for (const n of plan.notes) {
      if (n.exists) {
        skipped.push(`Note "${n.title}" is already on ${tgt.ticketNumber}.`);
        continue;
      }
      try {
        const id = await this.s.createTicketNote(tgt.id, { ...noteBase, title: n.title, description: n.description });
        done.push(`Added note "${n.title}" (ID ${id}) to ${tgt.ticketNumber}.`);
      } catch (e) {
        notesOk = false;
        failed.push(`Adding note "${n.title}" to ${tgt.ticketNumber} failed: ${errText(e)}`);
        break;
      }
    }
    if (!notesOk) return finish();

    // 3. Attachments
    for (const a of plan.attachments) {
      if (a.action === 'skip') {
        skipped.push(`Attachment "${a.title}" not copied: ${a.reason}.`);
        continue;
      }
      if (a.action === 'exists') {
        skipped.push(`Attachment "${a.title}" is already on ${tgt.ticketNumber}.`);
        continue;
      }
      try {
        const full = await this.s.getTicketAttachment(src.id, a.id, { includeData: true, maxInlineBase64Bytes: Number.MAX_SAFE_INTEGER });
        if (!full || typeof full.data !== 'string' || full.data.length === 0) {
          skipped.push(`Attachment "${a.title}" not copied: Autotask returned no file content for it.`);
          continue;
        }
        const bytes = Buffer.byteLength(full.data, 'base64');
        if (bytes > MAX_ATTACHMENT_BYTES) {
          skipped.push(`Attachment "${a.title}" not copied: ${bytes} bytes, over Autotask's ${MAX_ATTACHMENT_BYTES}-byte attachment limit.`);
          continue;
        }
        const att = full as AutotaskTicketAttachment;
        const req: Parameters<TicketOpsService['createTicketAttachment']>[1] = {
          title: a.copyTitle,
          fullPath: (att.fullPath as string | undefined) || a.title,
          data: full.data,
        };
        if (typeof att.contentType === 'string') req.contentType = att.contentType;
        if (typeof att.publish === 'number') req.publish = att.publish;
        const id = await this.s.createTicketAttachment(tgt.id, req);
        done.push(`Copied attachment "${a.title}" to ${tgt.ticketNumber} (ID ${id}).`);
      } catch (e) {
        failed.push(`Copying attachment "${a.title}" failed: ${errText(e)}`);
      }
    }
    if (failed.length) {
      skipped.push(`${src.ticketNumber} was not closed because a step failed; run the merge again to finish it.`);
      return finish();
    }

    // 4. Marker note on the source
    const intoTitle = TicketOps.mergedIntoTitle(tgt.ticketNumber);
    if (plan.sourceAlreadyMarked) {
      skipped.push(`Note "${intoTitle}" is already on ${src.ticketNumber}.`);
    } else {
      try {
        const id = await this.s.createTicketNote(src.id, {
          ...noteBase,
          title: intoTitle,
          description: `${intoTitle}: ${tgt.title}\nThe description, notes and file attachments of this ticket were copied to ${tgt.ticketNumber} (ID ${tgt.id}). ` +
            'This is not an Autotask merge: Autotask shows no merge link between the tickets.',
        });
        done.push(`Added note "${intoTitle}" (ID ${id}) to ${src.ticketNumber}.`);
      } catch (e) {
        failed.push(`Adding note "${intoTitle}" to ${src.ticketNumber} failed: ${errText(e)}`);
        return finish();
      }
    }

    // 5. Close the source
    if (plan.sourceComplete) {
      skipped.push(`${src.ticketNumber} is already Complete.`);
    } else {
      try {
        await this.s.updateTicket(src.id, { status: plan.completeStatus as number });
        done.push(`Set ${src.ticketNumber} to Complete.`);
      } catch (e) {
        failed.push(`Setting ${src.ticketNumber} to Complete failed: ${errText(e)}`);
      }
    }
    return finish();
  }
}

export interface PlannedNote {
  title: string;
  titleHead: string;
  description: string;
  exists?: boolean;
}

export interface PlannedAttachment {
  id: number;
  title: string;
  /** Title of the copy on the target: the source title plus "(from <source number> #<attachment id>)". */
  copyTitle: string;
  fileSize?: number;
  action: 'copy' | 'skip' | 'exists';
  reason?: string;
}

export interface MergeTicketRef {
  id: number;
  ticketNumber: string;
  title: string;
  company: NamedRef;
  status?: number | undefined;
}

export interface MergePlan {
  source: MergeTicketRef;
  target: MergeTicketRef;
  blockers: string[];
  warnings: string[];
  companyChange?: TicketChangePlan;
  completeStatus?: number;
  noteType?: number;
  publish?: number;
  notes: PlannedNote[];
  attachments: PlannedAttachment[];
  sourceNoteCount: number;
  sourceAlreadyMarked: boolean;
  sourceComplete: boolean;
}

export interface MergePreview {
  canMerge: boolean;
  blockers: string[];
  warnings: string[];
  source: string;
  sourceCompany: string;
  target: string;
  targetCompany: string;
  companyMove: string;
  contractAfterMove: string;
  contactAfterMove: string;
  notesToTarget: string;
  attachments: string;
  sourceAfter: string;
  nativeMerge: string;
}

export interface MergeOutcome {
  ok: boolean;
  done: string[];
  failed: string[];
  skipped: string[];
  plan: MergePreview;
}

/** Plain-words report of a merge run. */
export function mergeReport(o: MergeOutcome, plan: MergePlan): string {
  const head = o.ok
    ? `Merged ${plan.source.ticketNumber} into ${plan.target.ticketNumber} (copied, not an Autotask merge: Autotask shows no merge link).`
    : `The merge of ${plan.source.ticketNumber} into ${plan.target.ticketNumber} did NOT complete. Fix the failure and run autotask_merge_ticket again: steps already done are skipped.`;
  const parts = [head];
  if (o.done.length) parts.push('Done: ' + o.done.join(' '));
  if (o.failed.length) parts.push('Failed: ' + o.failed.join(' '));
  if (o.skipped.length) parts.push('Skipped: ' + o.skipped.join(' '));
  if (plan.warnings.length) parts.push('Note: ' + plan.warnings.join(' '));
  return parts.join('\n');
}
