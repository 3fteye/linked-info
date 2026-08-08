use std::{collections::HashMap, convert::Infallible, sync::RwLock};

use linked_info_domain::{Information, InformationId};
use linked_info_storage_port::InformationStore;

#[derive(Debug, Default)]
pub struct MemoryInformationStore {
    records: RwLock<HashMap<InformationId, Information>>,
}

impl InformationStore for MemoryInformationStore {
    type Error = Infallible;

    async fn list(&self) -> Result<Vec<Information>, Self::Error> {
        let records = self.records.read().expect("memory store lock poisoned");
        let mut items: Vec<_> = records.values().cloned().collect();
        items.sort_by_key(|item| item.created_at);
        Ok(items)
    }

    async fn find(&self, id: InformationId) -> Result<Option<Information>, Self::Error> {
        let records = self.records.read().expect("memory store lock poisoned");
        Ok(records.get(&id).cloned())
    }

    async fn save(&self, information: Information) -> Result<(), Self::Error> {
        let mut records = self.records.write().expect("memory store lock poisoned");
        records.insert(information.id, information);
        Ok(())
    }
}
