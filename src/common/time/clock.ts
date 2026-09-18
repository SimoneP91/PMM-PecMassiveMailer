import { Injectable } from '@nestjs/common';

/**
 * Injectable time. Everything that schedules, expires or paces asks the clock
 * instead of calling Date.now(), so a test can move time by hand instead of
 * sleeping 30 hours to see a batch settle.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

@Injectable()
export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}
