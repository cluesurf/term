// Ephemeral awareness, kept out of durable history on purpose. Cursors, selections, the
// active tool, the focused record, and typing indicators are presence, not document
// state: they expire, tolerate loss, and are never required for correctness. Soft leases
// are the same category: while someone is dragging, their gesture is treated as
// authoritative for a group of fields, but it is a lease with an expiry, not a lock, so
// others can still inspect, edit unrelated fields, or intentionally override.
//
// See note/library/base/design/collaboration-correctness.md.

export type PresenceState = {
  actor: string
  // free-form awareness payload (cursor, selection, focused mark, tool), not persisted
  focus?: string
  selection?: Array<string>
  // wall time this presence was last refreshed and when it lapses
  updatedAt: number
  expiresAt: number
}

// A presence channel: the current awareness of each actor, with automatic expiry. It is
// intentionally in-memory and lossy, never written to the store.
export class PresenceChannel {
  private states = new Map<string, PresenceState>()

  set(state: PresenceState): void {
    this.states.set(state.actor, state)
  }

  // Live presences at a given time, dropping any that have lapsed.
  all(now: number): Array<PresenceState> {
    return [...this.states.values()].filter(s => s.expiresAt > now)
  }

  // Drop lapsed presences.
  reap(now: number): void {
    for (const [actor, state] of this.states) {
      if (state.expiresAt <= now) {
        this.states.delete(actor)
      }
    }
  }

  clear(actor: string): void {
    this.states.delete(actor)
  }
}

export type Lease = {
  target: string // the record mark
  scope: Array<string> // the fields the lease covers
  actor: string
  expiresAt: number
}

// A registry of soft leases. A lease is advisory: it says who is actively editing which
// fields, so a UI can avoid two pointers fighting, but it never blocks a write.
export class LeaseRegistry {
  private leases: Array<Lease> = []

  acquire(lease: Lease): void {
    this.leases = this.leases.filter(
      l => !(l.target === lease.target && l.actor === lease.actor),
    )
    this.leases.push(lease)
  }

  // The actor holding a lease on a field at a given time, or undefined if free.
  heldBy(target: string, field: string, now: number): string | undefined {
    const held = this.leases.find(
      l => l.target === target && l.scope.includes(field) && l.expiresAt > now,
    )
    return held?.actor
  }

  release(target: string, actor: string): void {
    this.leases = this.leases.filter(
      l => !(l.target === target && l.actor === actor),
    )
  }

  reap(now: number): void {
    this.leases = this.leases.filter(l => l.expiresAt > now)
  }
}
