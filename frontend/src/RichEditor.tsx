import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { useEffect } from "react";

type Props = {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
};

export default function RichEditor({ value, onChange, placeholder, minHeight = 80 }: Props) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: placeholder ?? "Write something…" }),
    ],
    content: value,
    onUpdate({ editor }) {
      const html = editor.isEmpty ? "" : editor.getHTML();
      onChange(html);
    },
  });

  // Sync external value resets (e.g. form clear after submit)
  useEffect(() => {
    if (!editor) return;
    const current = editor.isEmpty ? "" : editor.getHTML();
    if (value !== current) {
      editor.commands.setContent(value || "");
    }
  }, [value, editor]);

  if (!editor) return null;

  return (
    <div className="rich-editor">
      <div className="rich-toolbar">
        <button
          type="button"
          className={`rich-tool ${editor.isActive("bold") ? "active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBold().run(); }}
          title="Bold"
        ><b>B</b></button>
        <button
          type="button"
          className={`rich-tool ${editor.isActive("italic") ? "active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleItalic().run(); }}
          title="Italic"
        ><i>I</i></button>
        <button
          type="button"
          className={`rich-tool ${editor.isActive("strike") ? "active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleStrike().run(); }}
          title="Strikethrough"
        ><s>S</s></button>
        <div className="rich-tool-divider" />
        <button
          type="button"
          className={`rich-tool ${editor.isActive("bulletList") ? "active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBulletList().run(); }}
          title="Bullet list"
        >• —</button>
        <button
          type="button"
          className={`rich-tool ${editor.isActive("orderedList") ? "active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleOrderedList().run(); }}
          title="Numbered list"
        >1. —</button>
        <div className="rich-tool-divider" />
        <button
          type="button"
          className={`rich-tool ${editor.isActive("blockquote") ? "active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleBlockquote().run(); }}
          title="Blockquote"
        >&ldquo;&rdquo;</button>
        <button
          type="button"
          className={`rich-tool ${editor.isActive("code") ? "active" : ""}`}
          onMouseDown={(e) => { e.preventDefault(); editor.chain().focus().toggleCode().run(); }}
          title="Inline code"
        >{"`"}</button>
      </div>
      <EditorContent editor={editor} style={{ minHeight }} />
    </div>
  );
}
