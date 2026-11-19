import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type FileContentResponse, useFileContent } from "@/hooks/useFileContent";
import type { CodeMirrorFileEditor } from "@/shell/codeMirror/CodeMirrorFileEditor";

import { type FilesPageLeaveGuard, FilesPageViewer, showsInFileViewer } from "./FilesPageViewer";

const captured = vi.hoisted(() => ({
  editor: null as ComponentProps<typeof CodeMirrorFileEditor> | null,
}));

vi.mock("@/hooks/useFileContent", () => ({ useFileContent: vi.fn() }));
vi.mock("@/shell/codeMirror/CodeMirrorFileEditor", () => ({
  CodeMirrorFileEditor: (props: ComponentProps<typeof CodeMirrorFileEditor>) => {
    captured.editor = props;
    return <div data-testid="editor">{props.content}</div>;
  },
}));
vi.mock("@/shell/FileViewer", () => ({
  FileViewer: ({ path }: { path: string }) => <div data-testid="file-viewer">{path}</div>,
}));

type FileResult = ReturnType<typeof useFileContent>;

function file(path: string, content: string, extra: Partial<FileContentResponse> = {}) {
  return {
    object: "session.environment.filesystem.file_content",
    path,
    content_type: null,
    encoding: "utf-8",
    content,
    bytes: content.length,
    ...extra,
  } satisfies FileContentResponse;
}

function renderViewer(
  path: string,
  result: Partial<FileResult>,
  props: Partial<ComponentProps<typeof FilesPageViewer>> = {},
) {
  vi.mocked(useFileContent).mockReturnValue({ isFetching: false, ...result } as FileResult);
  const onClose = vi.fn();
  const view = render(
    <FilesPageViewer conversationId="conv_1" path={path} active onClose={onClose} {...props} />,
  );
  return { onClose, ...view };
}

beforeEach(() => {
  captured.editor = null;
  vi.mocked(useFileContent).mockReset();
});
afterEach(cleanup);

describe("showsInFileViewer", () => {
  it("sends images, PDFs, 3D models and binary files to the app's viewer, and text to the editor", () => {
    expect(showsInFileViewer("logo.png", null)).toBe(true);
    expect(showsInFileViewer("guide.pdf", null)).toBe(true);
    expect(showsInFileViewer("part.stl", null)).toBe(true);
    expect(showsInFileViewer("README.md", null)).toBe(false);
  });
});

describe("FilesPageViewer", () => {
  it("reads the file only while its tab is on screen", () => {
    renderViewer("a.ts", { data: file("a.ts", "x") }, { active: false });
    expect(useFileContent).toHaveBeenCalledWith("conv_1", "a.ts", { visible: false });
  });

  it("edits text in CodeMirror at the cited position, with Changes and Close in its toolbar", async () => {
    const onShowChanges = vi.fn();
    const position = { line: 3 };
    const { onClose } = renderViewer(
      "src/a.ts",
      { data: file("src/a.ts", "const a = 1;", { truncated: true }) },
      { onShowChanges, position },
    );
    expect(screen.getByTestId("editor")).toHaveTextContent("const a = 1;");
    expect(captured.editor).toMatchObject({ path: "src/a.ts", truncated: true, position });
    await userEvent.click(screen.getByRole("button", { name: "Changes" }));
    expect(onShowChanges).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Close file" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers no Changes button where the file has no changes view", () => {
    renderViewer("a.ts", { data: file("a.ts", "x") });
    expect(screen.queryByRole("button", { name: "Changes" })).toBeNull();
  });

  it("shows an image in the app's viewer, and text-named bytes that aren't text there too", () => {
    renderViewer("logo.png", { data: file("logo.png", "", { content_type: "image/png" }) });
    expect(screen.getByTestId("file-viewer")).toHaveTextContent("logo.png");
    expect(screen.queryByTestId("editor")).toBeNull();
    cleanup();
    renderViewer("data.txt", {
      data: file("data.txt", btoa("\xff\xfe\xfd"), { encoding: "base64" }),
    });
    expect(screen.getByTestId("file-viewer")).toHaveTextContent("data.txt");
    expect(screen.queryByTestId("editor")).toBeNull();
  });

  it("shows a spinner while loading, and why a file couldn't open", () => {
    renderViewer("a.ts", { data: undefined });
    expect(screen.getByLabelText("Loading a.ts")).toBeInTheDocument();
    cleanup();
    renderViewer("a.ts", { isError: true, error: new Error("not found") } as never);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t open a.ts: not found");
  });

  describe("unsaved edits", () => {
    function renderDirty() {
      const unregister = vi.fn();
      let guard: FilesPageLeaveGuard | undefined;
      const registerLeaveGuard = vi.fn((next: FilesPageLeaveGuard) => {
        guard = next;
        return unregister;
      });
      const view = renderViewer("a.ts", { data: file("a.ts", "x") }, { registerLeaveGuard });
      return { registerLeaveGuard, unregister, guard: () => guard!, ...view };
    }

    it("asks before leaving only while the file has unsaved edits", () => {
      const { registerLeaveGuard, unregister } = renderDirty();
      expect(registerLeaveGuard).not.toHaveBeenCalled();
      act(() => captured.editor!.onDirtyChange!(true));
      expect(registerLeaveGuard).toHaveBeenCalledTimes(1);
      act(() => captured.editor!.onDirtyChange!(false));
      expect(unregister).toHaveBeenCalledTimes(1);
    });

    it("leaves on Discard changes and stays on Keep editing", async () => {
      const { guard } = renderDirty();
      act(() => captured.editor!.onDirtyChange!(true));
      let answer: Promise<string>;
      act(() => {
        answer = guard()();
      });
      await userEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
      await expect(answer!).resolves.toBe("leave");
      act(() => {
        answer = guard()();
      });
      await userEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
      await expect(answer!).resolves.toBe("cancel");
    });

    it("keeps the edits when the file closes while the question is open", async () => {
      const { guard, unmount } = renderDirty();
      act(() => captured.editor!.onDirtyChange!(true));
      let answer: Promise<string>;
      act(() => {
        answer = guard()();
      });
      await screen.findByRole("button", { name: "Discard changes" });
      unmount();
      await expect(answer!).resolves.toBe("cancel");
    });
  });
});
