import { describe, expect, it } from "vitest";
import {
  isAudiblyPlaying,
  isYoutubeAdPlayerClass,
  parseYoutubePlaylistSession,
  parseYoutubePlaylistUrl
} from "../src/workflows/youtubePlaylistPlay.js";

describe("YouTube playlist playback workflow", () => {
  it("normalizes a shared playlist URL without retaining unrelated tracking parameters", () => {
    expect(
      parseYoutubePlaylistUrl("https://youtube.com/playlist?list=PLnLXn6DxNUZvfUAtIXbXc_pCe_wBForny&si=tracking")
    ).toEqual({
      playlistId: "PLnLXn6DxNUZvfUAtIXbXc_pCe_wBForny",
      url: "https://www.youtube.com/playlist?list=PLnLXn6DxNUZvfUAtIXbXc_pCe_wBForny"
    });
  });

  it("rejects non-playlist YouTube URLs", () => {
    expect(() => parseYoutubePlaylistUrl("https://www.youtube.com/watch?v=abc")).toThrow("재생목록 URL");
  });

  it("requires playing, unmuted media with advancing time before reporting success", () => {
    expect(
      isAudiblyPlaying({
        exists: true,
        paused: false,
        muted: false,
        volume: 1,
        currentTime: 3,
        readyState: 4
      })
    ).toBe(true);
    expect(
      isAudiblyPlaying({
        exists: true,
        paused: false,
        muted: true,
        volume: 1,
        currentTime: 3,
        readyState: 4
      })
    ).toBe(false);
  });

  it("does not treat a YouTube advertisement as playlist playback", () => {
    expect(isYoutubeAdPlayerClass("html5-video-player ad-showing playing-mode")).toBe(true);
    expect(isYoutubeAdPlayerClass("html5-video-player playing-mode")).toBe(false);
  });

  it("uses the paired regular user browser by default and retains an explicit controlled fallback", () => {
    expect(parseYoutubePlaylistSession()).toBe("regular");
    expect(parseYoutubePlaylistSession("user-browser")).toBe("regular");
    expect(parseYoutubePlaylistSession("controlled")).toBe("controlled");
  });
});
