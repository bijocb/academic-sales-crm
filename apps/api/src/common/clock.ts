import { Injectable } from '@nestjs/common';

/** Source of "now" for all domain code. Never call Date.now()/new Date() directly (CLAUDE.md rule 8). */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    // eslint-disable-next-line no-restricted-syntax -- the one sanctioned place
    return new Date();
  }
}

/** Controllable clock for tests. */
export class FixedClock extends Clock {
  constructor(private current: Date) {
    super();
  }
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(date: Date): void {
    this.current = new Date(date.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
