-- =====================================================================
-- FreeRADIUS standard schema (PostgreSQL variant). The VPS-hosted
-- FreeRADIUS process reads/writes these tables for authn (radcheck),
-- authz (radreply), accounting (radacct), and client registry (nas).
-- See: https://github.com/FreeRADIUS/freeradius-server/tree/master/raddb/mods-config/sql/main/postgresql
-- =====================================================================

CREATE TABLE radcheck (
  id        SERIAL PRIMARY KEY,
  username  VARCHAR(64) NOT NULL DEFAULT '',
  attribute VARCHAR(64) NOT NULL DEFAULT '',
  op        VARCHAR(2)  NOT NULL DEFAULT '==',
  value     VARCHAR(253) NOT NULL DEFAULT ''
);
CREATE INDEX radcheck_username ON radcheck (username, attribute);

CREATE TABLE radreply (
  id        SERIAL PRIMARY KEY,
  username  VARCHAR(64) NOT NULL DEFAULT '',
  attribute VARCHAR(64) NOT NULL DEFAULT '',
  op        VARCHAR(2)  NOT NULL DEFAULT '=',
  value     VARCHAR(253) NOT NULL DEFAULT ''
);
CREATE INDEX radreply_username ON radreply (username, attribute);

CREATE TABLE radgroupcheck (
  id        SERIAL PRIMARY KEY,
  groupname VARCHAR(64) NOT NULL DEFAULT '',
  attribute VARCHAR(64) NOT NULL DEFAULT '',
  op        VARCHAR(2)  NOT NULL DEFAULT '==',
  value     VARCHAR(253) NOT NULL DEFAULT ''
);
CREATE INDEX radgroupcheck_groupname ON radgroupcheck (groupname, attribute);

CREATE TABLE radgroupreply (
  id        SERIAL PRIMARY KEY,
  groupname VARCHAR(64) NOT NULL DEFAULT '',
  attribute VARCHAR(64) NOT NULL DEFAULT '',
  op        VARCHAR(2)  NOT NULL DEFAULT '=',
  value     VARCHAR(253) NOT NULL DEFAULT ''
);
CREATE INDEX radgroupreply_groupname ON radgroupreply (groupname, attribute);

CREATE TABLE radusergroup (
  id        SERIAL PRIMARY KEY,
  username  VARCHAR(64) NOT NULL DEFAULT '',
  groupname VARCHAR(64) NOT NULL DEFAULT '',
  priority  INTEGER     NOT NULL DEFAULT 0
);
CREATE INDEX radusergroup_username ON radusergroup (username);

CREATE TABLE radacct (
  radacctid           BIGSERIAL PRIMARY KEY,
  acctsessionid       VARCHAR(64) NOT NULL,
  acctuniqueid        VARCHAR(32) NOT NULL UNIQUE,
  username            VARCHAR(64),
  realm               VARCHAR(64),
  nasipaddress        INET NOT NULL,
  nasportid           VARCHAR(32),
  nasporttype         VARCHAR(32),
  acctstarttime       TIMESTAMPTZ,
  acctupdatetime      TIMESTAMPTZ,
  acctstoptime        TIMESTAMPTZ,
  acctinterval        BIGINT,
  acctsessiontime     BIGINT,
  acctauthentic       VARCHAR(32),
  connectinfo_start   VARCHAR(50),
  connectinfo_stop    VARCHAR(50),
  acctinputoctets     BIGINT,
  acctoutputoctets    BIGINT,
  calledstationid     VARCHAR(50),
  callingstationid    VARCHAR(50),
  acctterminatecause  VARCHAR(32),
  servicetype         VARCHAR(32),
  framedprotocol      VARCHAR(32),
  framedipaddress     INET,
  framedipv6address   INET,
  framedipv6prefix    VARCHAR(50),
  framedinterfaceid   VARCHAR(50),
  delegatedipv6prefix VARCHAR(50),
  class               VARCHAR(64)
);
CREATE INDEX radacct_active_session ON radacct (acctuniqueid) WHERE acctstoptime IS NULL;
CREATE INDEX radacct_bulk_close    ON radacct (nasipaddress, acctstarttime) WHERE acctstoptime IS NULL;
CREATE INDEX radacct_start         ON radacct (acctstarttime);
CREATE INDEX radacct_username      ON radacct (username);

CREATE TABLE radpostauth (
  id        BIGSERIAL PRIMARY KEY,
  username  VARCHAR(64) NOT NULL,
  pass      VARCHAR(64) NOT NULL,
  reply     VARCHAR(32) NOT NULL,
  authdate  TIMESTAMPTZ NOT NULL DEFAULT now(),
  class     VARCHAR(64)
);
CREATE INDEX radpostauth_username ON radpostauth (username);

-- nas = the list of RADIUS clients (MikroTiks). FreeRADIUS reads this on
-- start to know which devices are allowed to send Access-Requests and what
-- shared secret to validate them with. Each MikroTik gets one row keyed by
-- its WG tunnel IP, populated by our provisioning flow.
CREATE TABLE nas (
  id          SERIAL PRIMARY KEY,
  nasname     VARCHAR(128) NOT NULL,
  shortname   VARCHAR(32),
  type        VARCHAR(30) DEFAULT 'other',
  ports       INTEGER,
  secret      VARCHAR(60) NOT NULL,
  server      VARCHAR(64),
  community   VARCHAR(50),
  description VARCHAR(200) DEFAULT 'RADIUS Client'
);
CREATE UNIQUE INDEX nas_nasname ON nas (nasname);

-- Track the RADIUS shared secret per router so provisioning is idempotent.
ALTER TABLE routers ADD COLUMN radius_secret TEXT;
