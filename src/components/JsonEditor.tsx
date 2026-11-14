import { basicSetup, EditorView } from "codemirror";
import { json } from "@codemirror/lang-json";
import { openSearchPanel } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef
} from "react";

export interface JsonEditorHandle {
  focus: () => void;
  openSearch: () => void;
}

interface JsonEditorProps {
  value: string;
  dark: boolean;
  onChange: (value: string) => void;
}

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12.5px",
    backgroundColor: "transparent"
  },
  ".cm-scroller": {
    fontFamily:
      '"JetBrains Mono", "SFMono-Regular", "SF Mono", Consolas, monospace',
    lineHeight: "1.65",
    overflow: "auto"
  },
  ".cm-content": {
    padding: "12px 0 40px",
    caretColor: "var(--accent)"
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--ink-3)",
    paddingRight: "6px"
  },
  ".cm-activeLine": {
    backgroundColor: "var(--editor-active)"
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--ink-2)"
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--editor-selection) !important"
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--search-match)"
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--search-match-active)"
  },
  ".cm-panels": {
    backgroundColor: "var(--card)",
    color: "var(--ink)",
    borderColor: "var(--line)"
  },
  ".cm-textfield": {
    backgroundColor: "var(--card-2)",
    border: "1px solid var(--line)",
    borderRadius: "4px",
    color: "var(--ink)"
  },
  ".cm-button": {
    backgroundImage: "none",
    backgroundColor: "var(--card-2)",
    border: "1px solid var(--line)",
    borderRadius: "4px",
    color: "var(--ink-2)"
  }
});

export const JsonEditor = forwardRef<JsonEditorHandle, JsonEditorProps>(
  function JsonEditor({ value, dark, onChange }, ref) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const themeCompartment = useRef(new Compartment());
    const suppressChange = useRef(false);

    useImperativeHandle(ref, () => ({
      focus: () => viewRef.current?.focus(),
      openSearch: () => {
        const view = viewRef.current;
        if (!view) return;
        view.focus();
        openSearchPanel(view);
      }
    }));

    useEffect(() => {
      if (!hostRef.current || viewRef.current) return;
      const view = new EditorView({
        parent: hostRef.current,
        state: EditorState.create({
          doc: value,
          extensions: [
            basicSetup,
            json(),
            EditorView.lineWrapping,
            editorTheme,
            themeCompartment.current.of(dark ? oneDark : []),
            EditorView.updateListener.of((update) => {
              if (!update.docChanged || suppressChange.current) return;
              onChange(update.state.doc.toString());
            })
          ]
        })
      });
      viewRef.current = view;
      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // The editor is intentionally created once; external value/theme changes
      // are dispatched through the effects below.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      const current = view.state.doc.toString();
      if (current === value) return;
      suppressChange.current = true;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value }
      });
      suppressChange.current = false;
    }, [value]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: themeCompartment.current.reconfigure(dark ? oneDark : [])
      });
    }, [dark]);

    return <div className="json-editor-host" ref={hostRef} />;
  }
);
