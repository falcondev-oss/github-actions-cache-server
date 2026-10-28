//! Stores the hash of each upload's capability, which its URL must carry.

use sea_orm_migration::prelude::*;
use sea_orm_migration::schema::char_len_null;

pub(super) struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &'static str {
        "m0002_upload_capabilities"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    #[expect(
        elided_lifetimes_in_paths,
        reason = "`async_trait` rejects the trait's elided lifetime spelled out"
    )]
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Nullable: uploads created before have none and are refused until cleanup removes them.
        manager
            .alter_table(
                Table::alter()
                    .table("uploads")
                    .add_column(char_len_null("capabilityHash", 64))
                    .take(),
            )
            .await
    }
}
