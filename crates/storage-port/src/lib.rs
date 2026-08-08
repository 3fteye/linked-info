use std::{error::Error, future::Future};

use linked_info_domain::{Information, InformationId};

pub trait InformationStore {
    type Error: Error;

    fn list(&self) -> impl Future<Output = Result<Vec<Information>, Self::Error>> + '_;

    fn find(
        &self,
        id: InformationId,
    ) -> impl Future<Output = Result<Option<Information>, Self::Error>> + '_;

    fn save(&self, information: Information) -> impl Future<Output = Result<(), Self::Error>> + '_;
}
