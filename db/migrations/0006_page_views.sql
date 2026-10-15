-- Operational, not court record: how many times each public page was viewed per UTC day.
-- Deliberately holds no IP address, cookie, user agent or anything else about the viewer.
CREATE TABLE musecourt.page_views (
  day   DATE NOT NULL,
  page  TEXT NOT NULL,
  views BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, page)
);
