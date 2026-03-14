# Performance Review Checklist

## Database
- [ ] No N+1 query patterns
- [ ] Indexes on frequently queried columns
- [ ] Pagination for large datasets
- [ ] Connection pooling configured
- [ ] Queries avoid SELECT *

## Memory
- [ ] Large objects disposed properly
- [ ] No memory leaks in event handlers
- [ ] Streams used for large files
- [ ] Caching strategy appropriate

## Network
- [ ] Batch API calls where possible
- [ ] Compression enabled
- [ ] CDN for static assets
- [ ] Lazy loading for non-critical resources

## Async Operations
- [ ] Long operations run async
- [ ] Proper error handling in async code
- [ ] Timeouts configured
- [ ] Queue for background jobs

## Caching
- [ ] Cache invalidation strategy defined
- [ ] TTLs appropriate for data freshness
- [ ] Cache stampede prevention
- [ ] Distributed cache for scaling
