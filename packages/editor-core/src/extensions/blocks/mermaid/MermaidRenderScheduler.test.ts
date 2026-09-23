import { describe, expect, it } from "vitest";
import {
  MermaidRenderScheduler,
  MermaidSvgCache,
} from "./MermaidRenderScheduler";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("MermaidRenderScheduler", () => {
  it("runs Mermaid work serially", async () => {
    const scheduler = new MermaidRenderScheduler();
    let active = 0;
    let maxActive = 0;
    const completed: number[] = [];
    const owners = Array.from({ length: 6 }, () => ({}));

    owners.forEach((owner, index) =>
      scheduler.enqueue(owner, async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await tick();
        completed.push(index);
        active--;
      }),
    );

    for (let i = 0; i < 20 && completed.length < owners.length; i++)
      await tick();
    expect(maxActive).toBe(1);
    expect(completed).toEqual([0, 1, 2, 3, 4, 5]);
    scheduler.dispose();
  });

  it("coalesces queued work for the same diagram", async () => {
    const scheduler = new MermaidRenderScheduler();
    const blocker = {};
    const owner = {};
    const calls: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    scheduler.enqueue(blocker, async () => blocked);
    scheduler.enqueue(owner, async () => {
      calls.push("old");
    });
    scheduler.enqueue(owner, async () => {
      calls.push("latest");
    });
    release();

    for (let i = 0; i < 10 && calls.length === 0; i++) await tick();
    expect(calls).toEqual(["latest"]);
    scheduler.dispose();
  });
});

describe("MermaidSvgCache", () => {
  it("retains all diagrams in the reported 68-diagram document", () => {
    const cache = new MermaidSvgCache();
    for (let index = 0; index < 68; index++)
      cache.set(`diagram-${index}`, `<svg>${index}</svg>`);
    expect(cache.size).toBe(68);
    for (let index = 0; index < 68; index++)
      expect(cache.get(`diagram-${index}`)).toBe(`<svg>${index}</svg>`);
  });
});

describe("Mermaid render request stability", () => {
  it("does not invalidate an in-flight render when the same document block is refreshed", async () => {
    const scheduler = new MermaidRenderScheduler();
    const owner = {};
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const task = async () => {
      calls++;
      await blocked;
    };

    scheduler.enqueue(owner, task);
    scheduler.enqueue(owner, task);
    scheduler.enqueue(owner, task);
    await tick();
    expect(calls).toBe(1);
    release();
    await tick();
    scheduler.dispose();
  });
});
