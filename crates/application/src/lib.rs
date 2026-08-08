use linked_info_domain::Information;
use linked_info_storage_port::InformationStore;

pub struct InformationService<S> {
    store: S,
}

impl<S> InformationService<S>
where
    S: InformationStore,
{
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub async fn list(&self) -> Result<Vec<Information>, S::Error> {
        self.store.list().await
    }

    pub async fn save(&self, information: Information) -> Result<(), S::Error> {
        self.store.save(information).await
    }
}

#[cfg(test)]
mod tests {
    use linked_info_domain::{Information, InformationContext};
    use linked_info_storage_memory::MemoryInformationStore;

    use super::*;

    #[tokio::test]
    async fn saved_information_can_be_listed() {
        let service = InformationService::new(MemoryInformationStore::default());
        let information = Information::new(
            "Useful command",
            "cargo test",
            None,
            InformationContext::default(),
        )
        .expect("valid information");

        service.save(information).await.expect("save succeeds");

        assert_eq!(service.list().await.expect("list succeeds").len(), 1);
    }
}
