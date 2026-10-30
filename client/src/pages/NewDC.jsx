import { Link } from 'react-router-dom';

// New DC: pick the kind first. Job work stays in this app; normal goes to Zoho Books.
export default function NewDC() {
  return (
    <>
      <div className="head"><h1>New Delivery Challan</h1></div>
      <p className="muted">What kind of challan is this?</p>
      <div className="dc-kinds">
        <Link className="dc-kind" to="/dc/new/normal">
          <div className="dc-kind-title">Normal DC</div>
          <div className="dc-kind-sub">Goods to a customer: supply on approval, client pickup, site delivery, others.</div>
          <ul>
            <li>Same form as the Zoho Books delivery challan</li>
            <li>Created in <b>Zoho Books</b> with its own DC number</li>
            <li>Print and e-way bill from Books</li>
          </ul>
        </Link>
        <Link className="dc-kind" to="/dc/new/job-work">
          <div className="dc-kind-title">Job Work DC</div>
          <div className="dc-kind-sub">Raw material sent to a job worker for coating, to come back as a new item.</div>
          <ul>
            <li>Raw item sent → coating → new item received back</li>
            <li>DC stays in <b>this app</b>; only stock moves are posted to Books</li>
            <li>Track receipts, balance and scrap</li>
          </ul>
        </Link>
      </div>
    </>
  );
}
