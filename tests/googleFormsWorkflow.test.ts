import { describe, expect, it } from "vitest";
import { validateFormSpec, verifyInspectedForm } from "../src/workflows/googleFormsJarvis.js";

describe("Google Forms creation workflow", () => {
  it("normalizes approved form specs", () => {
    const spec = validateFormSpec({
      title: "AI 서비스 선호도 설문조사",
      description: "설명",
      questions: [
        {
          title: "AI 도구를 얼마나 자주 사용하시나요?",
          type: "multiple_choice",
          options: ["거의 매일", "주 2-3회"]
        },
        {
          title: "AI 답변의 신뢰도를 어떻게 평가하시나요?",
          type: "linear_scale",
          lowLabel: "매우 낮음",
          highLabel: "매우 높음"
        }
      ]
    });

    expect(spec.questions[0].type).toBe("객관식 질문");
    expect(spec.questions[1].type).toBe("선형 배율");
  });

  it("verifies editor input values instead of relying on body text", () => {
    const spec = validateFormSpec({
      title: "AI 서비스 선호도 설문조사",
      description: "AI 도구 이용 경험과 선호 기능을 파악하기 위한 3분 설문입니다.",
      questions: [
        {
          title: "AI 도구를 얼마나 자주 사용하시나요?",
          type: "객관식 질문",
          options: ["거의 매일", "주 2-3회", "월 1-2회"]
        },
        {
          title: "사용해본 AI 도구를 선택해주세요.",
          type: "체크박스",
          options: ["ChatGPT", "Claude", "Gemini"]
        },
        {
          title: "앞으로 AI를 가장 활용하고 싶은 분야는 무엇인가요?",
          type: "단답형"
        }
      ]
    });

    const result = verifyInspectedForm(spec, {
      editUrl: "https://docs.google.com/forms/d/example/edit",
      title: spec.title,
      description: spec.description,
      updatedAt: new Date().toISOString(),
      questions: [
        {
          title: "AI 도구를 얼마나 자주 사용하시나요?",
          inferredType: "객관식 질문",
          optionValues: ["거의 매일", "주 2-3회", "월 1-2회"],
          inputValues: [
            { aria: "옵션 값", placeholder: "", value: "거의 매일" },
            { aria: "옵션 값", placeholder: "", value: "주 2-3회" },
            { aria: "옵션 값", placeholder: "", value: "월 1-2회" }
          ],
          text: "질문 본문에는 옵션 값이 보이지 않을 수 있습니다."
        },
        {
          title: "사용해본 AI 도구를 선택해주세요.",
          inferredType: "체크박스",
          optionValues: ["ChatGPT", "Claude", "Gemini"],
          inputValues: [
            { aria: "옵션 값", placeholder: "", value: "ChatGPT" },
            { aria: "옵션 값", placeholder: "", value: "Claude" },
            { aria: "옵션 값", placeholder: "", value: "Gemini" }
          ],
          text: "최소 선택 개수 최대 선택 개수 정확한 선택 개수"
        },
        {
          title: "앞으로 AI를 가장 활용하고 싶은 분야는 무엇인가요?",
          inferredType: "단답형",
          optionValues: [],
          inputValues: [{ aria: "단답형 텍스트", placeholder: "", value: "" }],
          text: "단답형 텍스트"
        }
      ]
    });

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });
});
