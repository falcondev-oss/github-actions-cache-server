//! The schema v9.10 left behind, which every database starts from. Frozen: later changes are
//! new migrations.

use sea_orm::DbBackend;
use sea_orm_migration::prelude::*;
use sea_orm_migration::schema::{
    big_integer, big_integer_null, char_len_null, integer, string_len, text,
};

pub(super) struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &'static str {
        "m0001_baseline"
    }
}

fn references_location(table: &'static str, column: &'static str) -> ForeignKeyCreateStatement {
    ForeignKey::create()
        .from(table, column)
        .to("storage_locations", "id")
        .on_delete(ForeignKeyAction::Cascade)
        .take()
}

fn index(
    name: &'static str,
    table: &'static str,
    columns: &[&'static str],
) -> IndexCreateStatement {
    let mut index = Index::create();
    index.name(name).table(table);
    for &column in columns {
        index.col(column);
    }
    index.take()
}

fn indexes() -> [IndexCreateStatement; 9] {
    [
        index(
            "idx_cache_entries_key_version",
            "cache_entries",
            &["key", "version"],
        ),
        index("idx_cache_entries_scope", "cache_entries", &["scope"]),
        index("idx_cache_entries_repoId", "cache_entries", &["repoId"]),
        index(
            "idx_cache_entries_locationId",
            "cache_entries",
            &["locationId"],
        ),
        index("idx_uploads_key_version", "uploads", &["key", "version"]),
        index("idx_uploads_scope", "uploads", &["scope"]),
        index("idx_uploads_repoId", "uploads", &["repoId"]),
        // A unique index over the whole identity exceeds MySQL's 3072-byte key limit, so it
        // covers a fixed-width hash of it.
        index(
            "idx_uploads_reservationHash",
            "uploads",
            &["reservationHash"],
        )
        .unique()
        .take(),
        index(
            "idx_storage_reader_leases_location_expiry",
            "storage_reader_leases",
            &["storageLocationId", "expiresAt"],
        ),
    ]
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    #[expect(
        elided_lifetimes_in_paths,
        reason = "`async_trait` rejects the trait's elided lifetime spelled out"
    )]
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let backend = manager.get_database_backend();
        // `text` like v9; MySQL can't index or key it without a length.
        let string = |column, length| {
            if backend == DbBackend::MySql {
                string_len(column, length)
            } else {
                text(column)
            }
        };
        let id = |column| string(column, 36);
        let tables = [
            Table::create()
                .table("storage_locations")
                .col(id("id").primary_key())
                .col(text("folderName"))
                .col(integer("partCount"))
                .col(big_integer_null("mergeStartedAt"))
                .col(big_integer_null("mergedAt"))
                .col(big_integer_null("partsDeletedAt"))
                .col(big_integer_null("lastDownloadedAt"))
                .col(big_integer_null("sizeBytes"))
                .take(),
            Table::create()
                .table("cache_entries")
                .col(id("id").primary_key())
                .col(string("key", 512))
                .col(string("version", 255))
                .col(string("scope", 255))
                .col(string("repoId", 255))
                .col(big_integer("updatedAt"))
                .col(id("locationId"))
                .foreign_key(&mut references_location("cache_entries", "locationId"))
                .take(),
            Table::create()
                .table("uploads")
                .col(big_integer("id").primary_key())
                .col(string("key", 512))
                .col(string("version", 255))
                .col(string("scope", 255))
                .col(string("repoId", 255))
                .col(big_integer("createdAt"))
                .col(big_integer_null("lastPartUploadedAt"))
                .col(integer("startedPartUploadCount").default(0))
                .col(integer("finishedPartUploadCount").default(0))
                .col(text("folderName"))
                .col(char_len_null("reservationHash", 64))
                .take(),
            Table::create()
                .table("merge_leases")
                .col(id("storageLocationId").primary_key())
                .col(id("token"))
                .col(big_integer("expiresAt"))
                .foreign_key(&mut references_location(
                    "merge_leases",
                    "storageLocationId",
                ))
                .take(),
            Table::create()
                .table("storage_reader_leases")
                .col(id("id").primary_key())
                .col(id("storageLocationId"))
                .col(string("scope", 16))
                .col(big_integer("expiresAt"))
                .foreign_key(&mut references_location(
                    "storage_reader_leases",
                    "storageLocationId",
                ))
                .take(),
        ];
        for mut table in tables {
            // MySQL compares strings case- and accent-insensitively by default; GitHub compares
            // exactly.
            if backend == DbBackend::MySql {
                table.character_set("utf8mb4").collate("utf8mb4_0900_bin");
            }
            manager.create_table(table).await?;
        }

        for index in indexes() {
            manager.create_index(index).await?;
        }
        Ok(())
    }
}
