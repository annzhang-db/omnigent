import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePullRequestInfo } from "@/hooks/usePullRequests";
import { type PullRequestPanelDetails, refreshSessionPullRequests } from "@/shell/PullRequestPanel";

import { PullRequestPageBody, pullRequestPageTab } from "./PullRequestPageBody";

const captured = vi.hoisted(() => ({
  details: null as ComponentProps<typeof PullRequestPanelDetails> | null,
}));

vi.mock("@/hooks/usePullRequests", () => ({
  usePullRequestInfo: vi.fn(() => ({ data: undefined })),
}));
vi.mock("@/shell/PullRequestPanel", () => ({
  PullRequestPanelDetails: (props: ComponentProps<typeof PullRequestPanelDetails>) => {
    captured.details = props;
    return <div data-testid="details">{props.refreshButton as ReactNode}</div>;
  },
  refreshSessionPullRequests: vi.fn(),
}));

const PR = "https://github.com/example-org/widgets/pull/12";

function renderBody(props: Partial<ComponentProps<typeof PullRequestPageBody>> = {}) {
  const client = new QueryClient();
  const onSectionChange = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <PullRequestPageBody
        conversationId="conv_1"
        prUrl={PR}
        section="comments"
        active
        onSectionChange={onSectionChange}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { client, onSectionChange };
}

beforeEach(() => {
  captured.details = null;
  vi.mocked(usePullRequestInfo).mockClear();
  vi.mocked(refreshSessionPullRequests).mockReset();
});
afterEach(cleanup);

describe("pullRequestPageTab", () => {
  it("shows Commits in the Changes section, and every other section as itself", () => {
    expect(pullRequestPageTab("commits")).toBe("changes");
    expect(pullRequestPageTab("comments")).toBe("comments");
    expect(pullRequestPageTab("changes")).toBe("changes");
  });
});

describe("PullRequestPageBody", () => {
  it("reads this pull request, polling only while its tab is on screen", () => {
    renderBody({ active: false });
    expect(usePullRequestInfo).toHaveBeenLastCalledWith("conv_1", { poll: false, prUrl: PR });
    cleanup();
    renderBody();
    expect(usePullRequestInfo).toHaveBeenLastCalledWith("conv_1", { poll: true, prUrl: PR });
    expect(captured.details).toMatchObject({ conversationId: "conv_1", showHeading: false });
  });

  it("shows the place's section, and reports only a section that actually changes", () => {
    const { onSectionChange } = renderBody({ section: "commits" });
    expect(captured.details?.activeTab).toBe("changes");
    act(() => captured.details!.setActiveTab("changes"));
    expect(onSectionChange).not.toHaveBeenCalled();
    act(() => captured.details!.setActiveTab("comments"));
    expect(onSectionChange).toHaveBeenCalledWith("comments");
  });

  it("refreshes the session's pull requests, disabled until the refresh settles", async () => {
    let finish!: () => void;
    vi.mocked(refreshSessionPullRequests).mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const { client } = renderBody();
    const refresh = screen.getByRole("button", { name: "Refresh" });
    await userEvent.click(refresh);
    expect(refreshSessionPullRequests).toHaveBeenCalledWith(client, "conv_1");
    expect(refresh).toBeDisabled();
    await act(async () => finish());
    expect(refresh).toBeEnabled();
  });
});
