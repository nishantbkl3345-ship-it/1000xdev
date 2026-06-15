import './ProductCard.css';

function StarRating({ value }) {
  if (value === null || value === undefined) return null;
  const full = Math.floor(value);
  const half = value - full >= 0.3;
  return (
    <span className="stars" aria-label={`${value} out of 5`}>
      {'★'.repeat(full)}
      {half ? '½' : ''}
      {'☆'.repeat(5 - full - (half ? 1 : 0))}
    </span>
  );
}

export default function ProductCard({ product, platform, variants }) {
  if (!product) return null;

  const mainImage = product.images?.[0];

  return (
    <div className="product-card">
      {/* Image */}
      {mainImage && (
        <div className="product-card__img-wrap">
          <img src={mainImage} alt={product.title || 'Product'} />
        </div>
      )}

      {/* Info */}
      <div className="product-card__info">
        <span className="product-card__platform">{platform}</span>
        <h2 className="product-card__title">{product.title || 'Title unavailable'}</h2>

        {/* Price row */}
        <div className="product-card__price-row">
          {product.price !== null && (
            <span className="product-card__price">
              {product.currency === 'INR' ? '₹' : '$'}{product.price.toLocaleString('en-IN')}
            </span>
          )}
          {product.mrp !== null && product.mrp !== product.price && (
            <span className="product-card__mrp">
              ₹{product.mrp.toLocaleString('en-IN')}
            </span>
          )}
          {product.discount && (
            <span className="product-card__discount">{product.discount}</span>
          )}
        </div>

        {/* Rating */}
        {product.rating !== null && (
          <div className="product-card__rating">
            <StarRating value={product.rating} />
            <span className="product-card__rating-num">{product.rating}</span>
            {product.reviewCount !== null && (
              <span className="product-card__reviews">
                ({product.reviewCount.toLocaleString('en-IN')} reviews)
              </span>
            )}
          </div>
        )}

        {/* Variants */}
        {variants && Object.keys(variants.available || {}).length > 0 && (
          <div className="product-card__section">
            <h4 className="product-card__section-title">📦 Variants</h4>
            {/* Show currently selected values */}
            {variants.selected && Object.entries(variants.selected).map(([key, value]) => (
              <div key={`sel-${key}`} className="product-card__meta-item" style={{marginBottom: 6}}>
                <span className="product-card__label">Selected {key}:</span>
                <span style={{fontWeight: 600}}>{value}</span>
              </div>
            ))}
            {/* Show all available options per dimension */}
            {Object.entries(variants.available).map(([key, options]) => (
              <div key={key} className="product-card__variants-row" style={{flexDirection: 'column', alignItems: 'flex-start'}}>
                <span className="product-card__label" style={{marginBottom: 6}}>
                  {key} ({options.length} options):
                </span>
                <div className="product-card__variant-chips">
                  {options.map((opt, i) => {
                    const isObj = typeof opt === 'object' && opt !== null;
                    const name = isObj ? opt.name : opt;
                    const price = isObj ? opt.price : null;
                    const image = isObj ? opt.image : null;
                    const isSelected = isObj
                      ? opt.selected
                      : variants.selected?.[key] === opt;
                    const isAvailable = isObj ? opt.available !== false : true;

                    return (
                      <div
                        key={i}
                        className={`product-card__variant-card ${isSelected ? 'product-card__variant-card--selected' : ''} ${!isAvailable ? 'product-card__variant-card--unavailable' : ''}`}
                      >
                        {image && (
                          <img src={image} alt={name} className="product-card__variant-img" />
                        )}
                        <span className="product-card__variant-name">{name}</span>
                        {price !== null && (
                          <span className="product-card__variant-price">₹{price.toLocaleString('en-IN')}</span>
                        )}
                        {!isAvailable && (
                          <span className="product-card__variant-unavailable">Unavailable</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Delivery */}
        {product.delivery && (product.delivery.eta || product.delivery.seller || product.delivery.cost) && (
          <div className="product-card__section">
            <h4 className="product-card__section-title">🚚 Delivery</h4>
            {product.delivery.eta && (
              <div className="product-card__meta-item">
                <span className="product-card__label">ETA</span>
                <span>{product.delivery.eta}</span>
              </div>
            )}
            {product.delivery.cost && (
              <div className="product-card__meta-item">
                <span className="product-card__label">Shipping</span>
                <span className={product.delivery.cost === 'FREE' ? 'text-green' : ''}>{product.delivery.cost}</span>
              </div>
            )}
            {product.delivery.seller && (
              <div className="product-card__meta-item">
                <span className="product-card__label">Seller</span>
                <span>{product.delivery.seller}</span>
              </div>
            )}
          </div>
        )}

        {/* Meta */}
        <div className="product-card__meta">
          {product.seller && (
            <div className="product-card__meta-item">
              <span className="product-card__label">Seller</span>
              <span>{product.seller}</span>
            </div>
          )}
          <div className="product-card__meta-item">
            <span className="product-card__label">Availability</span>
            <span className={product.availability === 'In Stock' ? 'text-green' : 'text-red'}>
              {product.availability}
            </span>
          </div>
        </div>

        {/* Highlights */}
        {product.highlights?.length > 0 && (
          <div className="product-card__section">
            <h4 className="product-card__section-title">✨ Highlights</h4>
            <ul className="product-card__highlights">
              {product.highlights.map((h, i) => (
                <li key={i}>{h}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Specs */}
        {product.specs && Object.keys(product.specs).length > 0 && (
          <div className="product-card__section">
            <h4 className="product-card__section-title">📋 Specifications</h4>
            <div className="product-card__specs">
              {Object.entries(product.specs).map(([key, val]) => (
                <div key={key} className="product-card__meta-item">
                  <span className="product-card__label">{key}</span>
                  <span>{val}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Image thumbnails */}
        {product.images?.length > 1 && (
          <div className="product-card__thumbs">
            {product.images.slice(0, 6).map((src, i) => (
              <img key={i} src={src} alt={`Product ${i + 1}`} className="product-card__thumb" />
            ))}
            {product.images.length > 6 && (
              <span className="product-card__thumb-more">+{product.images.length - 6}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

