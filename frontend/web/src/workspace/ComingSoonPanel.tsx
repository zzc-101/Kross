export function ComingSoonPanel({
  title,
  body
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="coming-soon">
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}
