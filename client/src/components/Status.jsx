const LABEL = { draft: 'Draft', confirming: 'Confirming…', confirmed: 'Confirmed', partial: 'Partially received', received: 'Fully received', closed: 'Closed', cancelled: 'Cancelled' };
export default function Status({ s }) {
  return <span className={`chip chip-${s}`}>{LABEL[s] || s}</span>;
}
