import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// LLM hay chèn <br> để xuống dòng trong ô bảng. Markdown không render HTML thô
// (cố ý - nội dung đến từ LLM), nên đổi riêng <br> thành ngắt dòng thật.
function remarkLineBreaks() {
  const isBr = (node: any) => node.type === "html" && /^<br\s*\/?>$/i.test(node.value.trim());

  const walk = (node: any) => {
    if (!Array.isArray(node.children)) return;
    node.children = node.children.map((child: any) => (isBr(child) ? { type: "break" } : child));
    node.children.forEach(walk);
  };

  return (tree: any) => walk(tree);
}

export default function Markdown({ content }: { content: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkLineBreaks]}
        skipHtml
        disallowedElements={["img"]}
        components={{
          // Bảng rộng hơn cửa sổ thì cuộn ngang trong khung riêng
          table: ({ children }) => (
            <div className="md-table">
              <table>{children}</table>
            </div>
          ),
          // Không cho link điều hướng cửa sổ app đi nơi khác
          a: ({ children }) => <span className="md-link">{children}</span>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
