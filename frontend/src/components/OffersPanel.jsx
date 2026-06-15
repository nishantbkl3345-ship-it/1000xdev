import './OffersPanel.css';

const CATEGORY_CONFIG = [
  { key: 'bankOffers', label: 'Bank Offers', icon: '🏦' },
  { key: 'emiOffers', label: 'EMI Offers', icon: '💳' },
  { key: 'exchangeOffers', label: 'Exchange Offers', icon: '🔄' },
  { key: 'coupons', label: 'Coupons', icon: '🎟️' },
  { key: 'deliveryOffers', label: 'Delivery', icon: '🚚' },
  { key: 'otherOffers', label: 'Other Offers', icon: '🏷️' },
];

export default function OffersPanel({ offers }) {
  if (!offers) return null;

  const totalOffers = Object.values(offers).reduce((sum, arr) => sum + arr.length, 0);

  if (totalOffers === 0) {
    return (
      <div className="offers-panel offers-panel--empty">
        <p>No offers found for this product.</p>
      </div>
    );
  }

  return (
    <div className="offers-panel">
      <h3 className="offers-panel__title">
        Offers <span className="offers-panel__count">{totalOffers}</span>
      </h3>
      {CATEGORY_CONFIG.map(({ key, label, icon }) => {
        const items = offers[key];
        if (!items || items.length === 0) return null;
        return (
          <div key={key} className="offers-panel__category">
            <h4 className="offers-panel__cat-title">
              <span>{icon}</span> {label}
            </h4>
            <ul className="offers-panel__list">
              {items.map((item, i) => (
                <li key={i} className="offers-panel__item">
                  <span className="offers-panel__desc">
                    {item.description}
                  </span>
                  {item.code && (
                    <code className="offers-panel__code">{item.code}</code>
                  )}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
