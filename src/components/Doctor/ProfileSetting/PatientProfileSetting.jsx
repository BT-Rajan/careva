import React, { useEffect, useRef, useState } from 'react'
import moment from 'moment';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { bloodGrupOptions } from '../../../constant/global';
import { useUpdatePatientMutation, useDeleteMyAccountMutation } from '../../../redux/api/patientApi';
import useAuthCheck from '../../../redux/hooks/useAuthCheck';
import { message, Modal, Input } from 'antd';
import ImageUpload from '../../UI/form/ImageUpload';
import pImage from '../../../images/avatar.jpg';
import { DatePicker } from 'antd';
import { loggedOut } from '../../../service/auth.service';

const PatientProfileSetting = () => {
    const { data } = useAuthCheck();
    const navigate = useNavigate();
    const { register, handleSubmit } = useForm({});
    const [userId, setUserId] = useState('');
    const [selectBloodGroup, setSelectBloodGroup] = useState('');
    const [selectValue, setSelectValue] = useState({})
    const [updatePatient, { isSuccess, isError, error, isLoading }] = useUpdatePatientMutation();
    const [deleteMyAccount, { isLoading: deleteLoading }] = useDeleteMyAccountMutation();
    const [deletePassword, setDeletePassword] = useState('');
    const [date, setDate] = useState(null);
    const [selectedImage, setSelectedImage] = useState(null);
    const [file, setFile] = useState(null);

    const onChange = (date, dateString) => { 
        setDate(moment(dateString).format());
    };

    useEffect(() => {
        if (data) {
            setUserId(data.id)
            setSelectBloodGroup(data?.bloodGroup)
        }
    }, [data]);

    useEffect(() => {
        if (!isLoading && isError) {
            message.error(error?.data?.message)
        }
        if (isSuccess) {
            message.success('Successfully Profile Updated')
        }
    }, [isLoading, isError, error, isSuccess])

    const handleChange = (e) => {
        setSelectValue({ ...selectValue, [e.target.name]: e.target.value })
        if (e.target.name === 'bloodGroup') {
            setSelectBloodGroup(e.target.value);
        }
    }

    // Pass 24 — Data Privacy & Retention. Genuinely destructive and irreversible (see
    // patient.service.ts's deleteMyAccount) — confirm-by-typing-password, a second
    // explicit confirmation modal, and log the user out immediately afterward, since
    // their account credentials no longer exist.
    const handleDeleteAccount = () => {
        if (!deletePassword) {
            message.error('Please enter your password to confirm.');
            return;
        }
        Modal.confirm({
            title: 'Delete your account permanently?',
            content: 'This will remove your personal information and cannot be undone. Your appointment and medical history will be retained in anonymized form as required by law.',
            okText: 'Delete My Account',
            okButtonProps: { danger: true },
            onOk: async () => {
                try {
                    await deleteMyAccount(deletePassword).unwrap();
                    message.success('Your account has been deleted.');
                    loggedOut();
                    navigate('/login', { replace: true });
                } catch (err) {
                    message.error(err?.data?.message || 'Failed to delete account');
                }
            }
        });
    };

    const onSubmit = (data) => {
        const obj = data;
        const newObj = { ...obj, ...selectValue };
        date && (newObj['dateOfBirth'] = date);
        const changedValue = Object.fromEntries(Object.entries(newObj).filter(([key, value]) => value !== ''));
        const formData = new FormData();
        selectedImage && formData.append('file', file);
        const changeData = JSON.stringify(changedValue);
        formData.append('data', changeData)
        updatePatient({ data: formData, id: userId })
    };

    return (
        <div style={{ marginBottom: '10rem' }}>
            <div className="w-100 mb-3 rounded mb-5 p-2" style={{ background: '#f8f9fa' }}>
                <h5 className="text-title mb-2 mt-3">Update Your Information</h5>
                <form className="row form-row" onSubmit={handleSubmit(onSubmit)}>
                    <div className="col-md-12">
                        <div className="form-group">
                            <div className='change-avatar d-flex gap-2 align-items-center'>
                                <Link to={'/'} className="my-3 patient-img">
                                    <img src={selectedImage ? selectedImage : data?.img || pImage} alt="" />
                                </Link>
                                <div className="mt-3">
                                    <ImageUpload setSelectedImage={setSelectedImage} setFile={setFile}/>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="col-md-6">
                        <div className="form-group mb-2 card-label">
                            <label>First Name <span className="text-danger">*</span></label>
                            <input defaultValue={data?.firstName} {...register("firstName")} className="form-control" />
                        </div>
                    </div>
                    <div className="col-md-6">
                        <div className="form-group mb-2 card-label">
                            <label>Last Name <span className="text-danger">*</span></label>
                            <input defaultValue={data?.lastName} {...register("lastName")} className="form-control" />
                        </div>
                    </div>
                    <div className="col-md-6">
                        <div className="form-group mb-2 card-label">
                            <label>Email <span className="text-danger">*</span></label>
                            <input defaultValue={data?.email} disabled className="form-control" />
                        </div>
                    </div>

                    <div className="col-md-6">
                        <div className="form-group mb-2 card-label">
                            <label>Date of Birth {moment(data?.dateOfBirth).format('LL')}</label>
                            <DatePicker onChange={onChange} format={"YYYY-MM-DD"} style={{ width: '100%', padding: '6px' }} />
                        </div>
                    </div>

                    <div className="col-md-6">
                        <div className="form-group mb-2 card-label">
                            <label>Phone Number</label>
                            <input defaultValue={data?.mobile} {...register("mobile")} className="form-control" />
                        </div>
                    </div>
                    <div className="col-md-6">
                        <div className="form-group mb-2">
                            <label>Gender</label>
                            <select className="form-control select" onChange={handleChange} name='gender'>
                                <option value={''}>Select</option>
                                <option className='text-capitalize'>male</option>
                                <option className='text-capitalize'>female</option>
                                <option className='text-capitalize'>shemale</option>
                            </select>
                        </div>
                    </div>

                    <div className="col-md-6">
                        <div className="form-group mb-2">
                            <label className='form-label'>Blood Group</label>
                            <select className="form-control select"
                                onChange={handleChange}
                                name='bloodGroup'
                                value={selectBloodGroup}
                            >
                                {
                                    bloodGrupOptions.map((option, index) => (
                                        <option key={index} value={option.value} className='text-capitalize'>{option.label}</option>
                                    ))
                                }
                            </select>
                        </div>
                    </div>

                    <div className="col-md-6">
                        <div className="form-group mb-2">
                            <label className='form-label'>City</label>
                            <input defaultValue={data?.city} {...register("city")} className="form-control" />
                        </div>
                    </div>

                    <div className="col-md-6">
                        <div className="form-group mb-2 card-label">
                            <label>State</label>
                            <input defaultValue={data?.state} {...register("state")} className="form-control" />
                        </div>
                    </div>
                    <div className="col-md-6">
                        <div className="form-group mb-2 card-label">
                            <label>Zip Code</label>
                            <input defaultValue={data?.zipCode} {...register("zipCode")} className="form-control" />
                        </div>
                    </div>
                    <div className="col-md-6">
                        <div className="form-group mb-2 card-label">
                            <label>Country</label>
                            <input defaultValue={data?.country} {...register("country")} className="form-control" />
                        </div>
                    </div>
                    <div className="col-md-6">
                        <div className="form-group mb-2 card-label">
                            <label>Address</label>
                            <input defaultValue={data?.address} {...register("address")} className="form-control" />
                        </div>
                    </div>
                    <div className='text-center'>
                        <button type="submit" className="btn btn-primary my-3" disabled={isLoading ? true : false}>{isLoading ? 'Updating..' : 'Save Changes'}</button>
                    </div>
                </form>

                {/* Pass 24 — Data Privacy & Retention: self-service account deletion. */}
                <div className="mt-5 p-4" style={{ border: '1px solid #f5222d', borderRadius: '8px' }}>
                    <h5 className="text-danger">Danger Zone</h5>
                    <p className="text-muted mb-3">Deleting your account permanently removes your personal information. This cannot be undone.</p>
                    <div className="row">
                        <div className="col-md-6 mb-2">
                            <Input.Password
                                placeholder="Enter your password to confirm"
                                value={deletePassword}
                                onChange={(e) => setDeletePassword(e.target.value)}
                            />
                        </div>
                    </div>
                    <button
                        type="button"
                        className="btn btn-outline-danger"
                        disabled={deleteLoading}
                        onClick={handleDeleteAccount}
                    >
                        {deleteLoading ? 'Deleting...' : 'Delete My Account'}
                    </button>
                </div>
            </div>
        </div>
    )
}

export default PatientProfileSetting