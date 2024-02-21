CREATE TABLE `cache_keys` (
	`key` text NOT NULL,
	`version` text NOT NULL,
	PRIMARY KEY(`key`, `version`)
);
