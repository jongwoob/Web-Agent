import { describe, expect, it } from "vitest";
import { parseNaverMailCommand } from "../src/workflows/naverMail.js";

describe("Naver mail workflow parser", () => {
  it("extracts recipient and subject from Korean send command", () => {
    const parsed = parseNaverMailCommand("recipient@example.com 에게 주문 건 메일 보내기");

    expect(parsed.to).toBe("recipient@example.com");
    expect(parsed.subject).toBe("주문 건");
  });

  it("supports email wording", () => {
    const parsed = parseNaverMailCommand("test@example.com 한테 견적 문의 이메일 작성");

    expect(parsed.to).toBe("test@example.com");
    expect(parsed.subject).toBe("견적 문의");
  });
});
