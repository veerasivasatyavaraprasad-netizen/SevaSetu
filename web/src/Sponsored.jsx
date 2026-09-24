import { useEffect, useState } from 'react';
import { api } from './api.js';

// Sponsored brand placements (plan §2 advertising), always labelled.
export default function Sponsored({ slot, category, pincode }) {
  const [ads, setAds] = useState([]);
  useEffect(() => {
    const qs = new URLSearchParams({ slot, ...(category ? { category } : {}), ...(pincode ? { pincode } : {}) });
    api(`/ads?${qs}`).then((d) => setAds(d.ads)).catch(() => setAds([]));
  }, [slot, category, pincode]);
  if (!ads.length) return null;
  return ads.map((a) => (
    <a key={a.id} href={a.clickUrl} target="_blank" rel="noopener noreferrer sponsored" className="card list-item" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      {a.imageUrl && <img src={a.imageUrl} alt="" width={64} height={64} style={{ borderRadius: 10, objectFit: 'cover', flex: 'none' }} />}
      <span className="grow">
        <span className="badge" style={{ marginBottom: 4 }}>Sponsored · {a.brand}</span>
        <strong style={{ display: 'block' }}>{a.title}</strong>
        {a.body && <span className="small muted">{a.body}</span>}
      </span>
    </a>
  ));
}
